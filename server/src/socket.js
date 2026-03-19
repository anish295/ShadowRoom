// Per-room user tracking: roomCode -> Map<socketId, { socketId, userName }>
const roomUsers = new Map();

function getRoomUsersList(roomCode) {
  const users = roomUsers.get(roomCode);
  if (!users) return [];
  return Array.from(users.values());
}

export function registerSocketHandlers(io, { pinStore, logger }) {
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

      socket.data.chatRoom = code;
      socket.data.chatUserName = userName;
      socket.join(code);

      // Add user to room tracking
      if (!roomUsers.has(code)) {
        roomUsers.set(code, new Map());
      }
      roomUsers.get(code).set(socket.id, { socketId: socket.id, userName });

      // Broadcast updated user list to entire room
      io.to(code).emit("users-updated", getRoomUsersList(code));
      logger.info("user joined chat room", { code, userName, socketId: socket.id });
    });

    socket.on("leave-room", () => {
      const code = socket.data.chatRoom;
      if (!code) return;

      const users = roomUsers.get(code);
      if (users) {
        users.delete(socket.id);
        if (users.size === 0) {
          roomUsers.delete(code);
        } else {
          io.to(code).emit("users-updated", getRoomUsersList(code));
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

    // ==================== FILE SHARING ====================
    // After uploading via HTTP, the client emits this event so we can relay to other users.
    // Using socket.to() ensures the uploader NEVER gets their own file back.
    socket.on("file-shared", (fileInfo = {}) => {
      const { roomCode } = fileInfo;
      if (!roomCode) return;
      const code = String(roomCode).toUpperCase();
      socket.to(code).emit("file-uploaded", fileInfo);
    });

    // ==================== CHAT MESSAGING ====================
    // Use socket.to() instead of io.to() so the SENDER doesn't get their own message back
    // (the client already optimistically adds it to state)
    socket.on("send-message", (payload = {}) => {
      const { text, roomCode, userName, ts } = payload;
      if (!roomCode || !text) return;
      const code = String(roomCode).toUpperCase();
      socket.join(code);
      const enriched = {
        text,
        roomCode: code,
        userName: userName || "Anon",
        ts: ts || Date.now(),
      };
      // Broadcast to everyone EXCEPT the sender
      socket.to(code).emit("receive-message", enriched);
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
            roomUsers.delete(chatRoom);
          } else {
            io.to(chatRoom).emit("users-updated", getRoomUsersList(chatRoom));
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
