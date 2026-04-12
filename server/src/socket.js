// Per-room user tracking: roomCode -> Map<socketId, { socketId, userName }>
const roomUsers = new Map();

function getRoomUsersList(roomCode, roomsByCode) {
  const users = roomUsers.get(roomCode);
  if (!users) return [];

  const adminSocketId = roomsByCode?.get(roomCode)?.adminSocketId;
  return Array.from(users.values()).map((user) => ({
    ...user,
    isAdmin: Boolean(adminSocketId && user.socketId === adminSocketId),
  }));
}

function getNextAdminSocketId(roomCode) {
  const users = roomUsers.get(roomCode);
  if (!users || users.size === 0) return null;
  return users.values().next().value?.socketId || null;
}

function emitUsersUpdated(io, roomCode, roomsByCode) {
  io.to(roomCode).emit("users-updated", getRoomUsersList(roomCode, roomsByCode));
}

function setAdminAndBroadcast(io, roomCode, roomsByCode, adminSocketId) {
  if (!roomsByCode || !roomsByCode.has(roomCode)) return;
  const room = roomsByCode.get(roomCode);
  room.adminSocketId = adminSocketId || null;

  const adminName = adminSocketId
    ? roomUsers.get(roomCode)?.get(adminSocketId)?.userName || null
    : null;

  io.to(roomCode).emit("admin-changed", {
    roomCode,
    adminId: room.adminSocketId,
    adminName,
  });
}

function removeRoomIfEmpty(roomCode, roomsByCode) {
  const users = roomUsers.get(roomCode);
  if (!users || users.size === 0) {
    roomUsers.delete(roomCode);
    if (roomsByCode && roomsByCode.has(roomCode)) {
      roomsByCode.delete(roomCode);
    }
    return true;
  }
  return false;
}

export function registerSocketHandlers(io, { pinStore, logger, roomsByCode }) {
  io.on("connection", (socket) => {
    logger.info("socket connected", { id: socket.id });

    socket.on("pin:create", () => {
      const pin = pinStore.createPin({ socketId: socket.id });
      if (!pin) {
        socket.emit("pin:created", { ok: false, reason: "PIN_GENERATION_FAILED" });
        return;
      }

      socket.data.pin = pin;
      socket.join(pin);
      socket.emit("pin:created", { ok: true, pin });
      logger.info("pin created", { pin, socketId: socket.id });
    });

    socket.on("pin:join", ({ pin } = {}) => {
      const result = pinStore.join(pin, { socketId: socket.id });
      if (!result.ok) {
        socket.emit("pin:join:result", { ok: false, reason: result.reason });
        return;
      }

      socket.data.pin = pin;
      socket.join(pin);
      socket.emit("pin:join:result", { ok: true });
      logger.info("pin joined", { pin, socketId: socket.id });

      // If room now has 2 peers, notify both sides they can start WebRTC.
      const peerId = pinStore.getPeerSocketId(pin, socket.id);
      if (peerId) {
        // Role assignment is optional but useful for client logic
        socket.emit("peer:ready", { role: "receiver" });
        io.to(peerId).emit("peer:ready", { role: "sender" });
      }
    });

    socket.on("webrtc:signal", ({ pin, data } = {}) => {
      const activePin = socket.data.pin;
      const roomPin = typeof pin === "string" ? pin : activePin;
      if (!roomPin) return;

      const peerId = pinStore.getPeerSocketId(roomPin, socket.id);
      if (!peerId) return;

      io.to(peerId).emit("webrtc:signal", { data });
    });

    // ==================== CHAT ROOM USER TRACKING ====================

    socket.on("join-room", ({ roomCode, userName } = {}) => {
      if (!roomCode || !userName) return;
      const code = String(roomCode).toUpperCase();

      if (roomsByCode && !roomsByCode.has(code)) {
        socket.emit("join-room-error", { message: "Room not found" });
        return;
      }

      socket.data.chatRoom = code;
      socket.data.chatUserName = userName;
      socket.join(code);

      // Add user to room tracking
      if (!roomUsers.has(code)) {
        roomUsers.set(code, new Map());
      }
      roomUsers.get(code).set(socket.id, { socketId: socket.id, userName });

      const room = roomsByCode?.get(code);
      if (room && !room.adminSocketId) {
        // Prefer the original creator name, but always ensure there is exactly one admin.
        if (userName === room.adminName || roomUsers.get(code).size === 1) {
          setAdminAndBroadcast(io, code, roomsByCode, socket.id);
        }
      }

      // Broadcast updated user list to entire room
      emitUsersUpdated(io, code, roomsByCode);
      logger.info("user joined chat room", { code, userName, socketId: socket.id });
    });

    socket.on("leave-room", () => {
      const code = socket.data.chatRoom;
      if (!code) return;

      const users = roomUsers.get(code);
      if (users) {
        users.delete(socket.id);
        if (users.size === 0) {
          removeRoomIfEmpty(code, roomsByCode);
        } else {
          const room = roomsByCode?.get(code);
          if (room?.adminSocketId === socket.id) {
            const nextAdminId = getNextAdminSocketId(code);
            setAdminAndBroadcast(io, code, roomsByCode, nextAdminId);
          }
          emitUsersUpdated(io, code, roomsByCode);
        }
      }

      socket.leave(code);
      socket.data.chatRoom = null;
      socket.data.chatUserName = null;
      logger.info("user left chat room", { code, socketId: socket.id });
    });

    // ==================== TYPING INDICATOR ====================

    socket.on("typing", ({ roomCode } = {}) => {
      if (!roomCode) return;
      const code = String(roomCode).toUpperCase();
      const userName = socket.data.chatUserName || "Anon";
      // Broadcast to everyone EXCEPT the sender
      socket.to(code).emit("user-typing", { userName, socketId: socket.id });
    });

    socket.on("stop-typing", ({ roomCode } = {}) => {
      if (!roomCode) return;
      const code = String(roomCode).toUpperCase();
      const userName = socket.data.chatUserName || "Anon";
      socket.to(code).emit("user-stop-typing", { userName, socketId: socket.id });
    });

    // ==================== P2P FILE TRANSFER SIGNALING ====================
    // The server NEVER touches file data. It only relays lightweight signaling
    // messages so peers can establish WebRTC DataChannel connections for file transfer.

    // Sender broadcasts file offer metadata to the room (name, size, type — ~200 bytes)
    socket.on("file-offer", (payload = {}) => {
      const { roomCode, transferId } = payload;
      if (!roomCode || !transferId) return;
      const code = String(roomCode).toUpperCase();
      // Attach sender's socketId so receivers know who to connect to
      socket.to(code).emit("file-offer", {
        ...payload,
        roomCode: code,
        senderSocketId: socket.id,
      });
    });

    // Receiver accepts and wants to establish a WebRTC connection to the sender
    socket.on("file-accept", (payload = {}) => {
      const { senderSocketId, transferId } = payload;
      if (!senderSocketId || !transferId) return;
      // Forward to the sender with the receiver's socketId
      io.to(senderSocketId).emit("file-accept", {
        ...payload,
        receiverSocketId: socket.id,
      });
    });

    // Relay WebRTC signaling data for file transfer connections
    // (SDP offers/answers and ICE candidates scoped by transferId)
    socket.on("file-signal", ({ targetSocketId, transferId, data } = {}) => {
      if (!targetSocketId || !transferId || !data) return;
      io.to(targetSocketId).emit("file-signal", {
        fromSocketId: socket.id,
        transferId,
        data,
      });
    });

    // Receiver declines the file offer
    socket.on("file-decline", (payload = {}) => {
      const { senderSocketId, transferId } = payload;
      if (!senderSocketId || !transferId) return;
      io.to(senderSocketId).emit("file-decline", {
        ...payload,
        receiverSocketId: socket.id,
      });
    });

    // Receiver timed out (did not respond in time)
    socket.on("file-timeout", (payload = {}) => {
      const { senderSocketId, transferId } = payload;
      if (!senderSocketId || !transferId) return;
      io.to(senderSocketId).emit("file-timeout", {
        ...payload,
        receiverSocketId: socket.id,
      });
    });

    // ==================== CHAT MESSAGING ====================
    // Use socket.to() instead of io.to() so the SENDER doesn't get their own message back
    // (the client already optimistically adds it to state)
    socket.on("send-message", (payload = {}) => {
      const { text, roomCode, userName, ts, msgId, replyTo } = payload;
      if (!roomCode || !text) return;

      // Input validation: reject oversized messages
      if (typeof text !== "string" || text.length > 10_000) return;
      if (typeof userName === "string" && userName.length > 50) return;

      const code = String(roomCode).toUpperCase();
      socket.join(code);
      const enriched = {
        msgId: typeof msgId === "string" ? msgId.slice(0, 64) : undefined,
        text: text.slice(0, 10_000),
        roomCode: code,
        userName: String(userName || "Anon").slice(0, 50),
        userId: socket.id,
        ts: ts || Date.now(),
        replyTo:
          replyTo && typeof replyTo === "object"
            ? {
              msgId: String(replyTo.msgId || "").slice(0, 64),
              userId: String(replyTo.userId || "").slice(0, 64),
              userName: String(replyTo.userName || "").slice(0, 50),
              snippet: String(replyTo.snippet || "").slice(0, 200),
            }
            : undefined,
      };
      // Broadcast to everyone EXCEPT the sender
      socket.to(code).emit("receive-message", enriched);
    });

    socket.on("kick-user", ({ roomCode, targetSocketId } = {}) => {
      if (!roomCode || !targetSocketId) return;
      const code = String(roomCode).toUpperCase();
      const room = roomsByCode?.get(code);
      if (!room) return;
      if (room.adminSocketId !== socket.id) return;
      if (targetSocketId === socket.id) return;

      const users = roomUsers.get(code);
      if (!users || !users.has(targetSocketId)) return;

      const kickedUser = users.get(targetSocketId);
      users.delete(targetSocketId);

      const targetSocket = io.sockets.sockets.get(targetSocketId);
      if (targetSocket) {
        targetSocket.leave(code);
        targetSocket.data.chatRoom = null;
        targetSocket.data.chatUserName = null;
        targetSocket.emit("kicked", {
          roomCode: code,
          kickedBy: socket.data.chatUserName || "Admin",
        });
      }

      io.to(code).emit("system-message", {
        text: `${kickedUser.userName} was removed by admin.`,
        ts: Date.now(),
      });
      emitUsersUpdated(io, code, roomsByCode);
      logger.info("user kicked from room", {
        code,
        bySocketId: socket.id,
        targetSocketId,
      });
    });

    // ==================== DISCONNECT ====================

    socket.on("disconnect", (reason) => {
      logger.info("socket disconnected", { id: socket.id, reason });

      // Clean up chat room user tracking
      const chatRoom = socket.data.chatRoom;
      if (chatRoom) {
        const users = roomUsers.get(chatRoom);
        if (users) {
          users.delete(socket.id);
          if (users.size === 0) {
            removeRoomIfEmpty(chatRoom, roomsByCode);
          } else {
            const room = roomsByCode?.get(chatRoom);
            if (room?.adminSocketId === socket.id) {
              const nextAdminId = getNextAdminSocketId(chatRoom);
              setAdminAndBroadcast(io, chatRoom, roomsByCode, nextAdminId);
            }
            emitUsersUpdated(io, chatRoom, roomsByCode);
          }
        }
      }

      // Clean up pin-based rooms
      const pins = pinStore.leaveBySocketId(socket.id);
      for (const pin of pins) {
        // Notify the remaining peer in that room (if any).
        socket.to(pin).emit("peer:disconnected");
      }
    });
  });
}
