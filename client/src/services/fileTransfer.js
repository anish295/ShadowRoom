/**
 * P2P File Transfer Service v4 — StrictMode-Safe
 *
 * Root-cause fix: React 18 StrictMode double-fires effects (mount → unmount
 * → remount). The previous destroy() killed active peers mid-transfer.
 *
 * Solution: Peer state lives in a MODULE-LEVEL singleton that survives React
 * effect re-fires. The destroy() function only removes socket listeners;
 * active transfers keep running.
 *
 * Protocol:
 *  Sender                                   Receiver
 *    |-- file-offer (socket.io) ------------->|
 *    |                          [Accept/Decline UI, showSaveFilePicker]
 *    |<-------- file-accept (socket.io) ------|
 *    |<===== WebRTC signaling exchange ======>|
 *    |          [DataChannel opens]           |
 *    |                                        |-- { t: "ready" }
 *    |<-------- ready signal -----------------|
 *    |-- { t: "file-meta", ... } ------------>|
 *    |-- [64KB chunk] ----------------------->|  (writes to disk/memory)
 *    |   (backpressure: waits for drain)      |
 *    |-- ...                                  |
 *    |-- { t: "file-end" } ----------------->|
 *    |                            [close writable, verify]
 *    |<-------- { t: "transfer-complete" } ---|
 *    |          [both wait 2s, then destroy]   |
 */

import * as SimplePeerNamespace from "simple-peer";
const Peer = SimplePeerNamespace.default ?? SimplePeerNamespace;

// ─── Constants ───────────────────────────────────────────────────────
// WebRTC DataChannel SCTP max message size is ~256KB in Chrome.
// Using 64KB to stay well within limits and work on all browsers.
const CHUNK_SIZE = 64 * 1024;                      // 64KB per DataChannel message
const BUFFERED_AMOUNT_HIGH = 2 * 1024 * 1024;      // 2MB  pause threshold
const BUFFERED_AMOUNT_LOW  = 512 * 1024;            // 512KB resume threshold
const OFFER_TIMEOUT_MS = 30_000;                    // 30s for accept/decline

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
];


 // Public TURN servers for NAT traversal when STUN alone isn't sufficient
 const TURN_SERVERS = [
   {
     urls: "turn:openrelay.metered.ca:80",
     username: "openrelayproject",
     credential: "openrelayproject",
   },
   {
     urls: "turn:openrelay.metered.ca:443",
     username: "openrelayproject",
     credential: "openrelayproject",
   },
 ];

 // Combine STUN and TURN servers
 const ICE_SERVERS = [...STUN_SERVERS, ...TURN_SERVERS];
// ─── Module-level receiver state (survives React StrictMode re-fires) ───
const _activePeers = new Map();    // transferId -> state (persists across effect re-runs)
const _pendingOffers = new Map();  // transferId -> offer payload
const _pendingSignals = new Map(); // transferId -> [{ fromSocketId, data }]

// ─── Helpers ─────────────────────────────────────────────────────────
function makeTransferId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function formatBytes(n) {
  const x = Number(n || 0);
  if (x < 1024) return `${x} B`;
  const kb = x / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function hasFileSystemAccess() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

async function checkStorageQuota(requiredBytes) {
  if (!navigator?.storage?.estimate) return { ok: true, available: Infinity };
  try {
    const est = await navigator.storage.estimate();
    const available = (est.quota || 0) - (est.usage || 0);
    return { ok: available > requiredBytes, available };
  } catch {
    return { ok: true, available: Infinity };
  }
}

function waitForBufferDrain(channel) {
  return new Promise((resolve, reject) => {
    if (!channel || channel.readyState !== "open") {
      reject(new Error("Channel closed while waiting for drain"));
      return;
    }
    if (channel.bufferedAmount <= BUFFERED_AMOUNT_LOW) {
      resolve();
      return;
    }
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW;
    let resolved = false;

    const done = () => {
      if (resolved) return;
      resolved = true;
      clearInterval(poll);
      channel.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };

    const onLow = () => done();
    channel.addEventListener("bufferedamountlow", onLow, { once: true });

    const poll = setInterval(() => {
      if (!channel || channel.readyState !== "open") {
        if (!resolved) {
          resolved = true;
          clearInterval(poll);
          channel?.removeEventListener("bufferedamountlow", onLow);
          reject(new Error("Channel closed while waiting for drain"));
        }
        return;
      }
      if (channel.bufferedAmount <= BUFFERED_AMOUNT_LOW) done();
    }, 50);
  });
}

function safeSend(peer, data) {
  if (!peer || peer.destroyed) return false;
  try {
    const ch = peer._channel;
    if (!ch || ch.readyState !== "open") return false;
    peer.send(data);
    return true;
  } catch (err) {
    console.warn("[P2P] safeSend failed:", err.message);
    return false;
  }
}

function queuePendingSignal(transferId, signalPacket) {
  const queue = _pendingSignals.get(transferId) || [];
  queue.push(signalPacket);
  _pendingSignals.set(transferId, queue);
  return queue.length;
}

function flushPendingSignals(transferId, peer, prefix = "[P2P Receiver]") {
  const queue = _pendingSignals.get(transferId);
  if (!queue || queue.length === 0) return;
  console.log(`${prefix} Flushing ${queue.length} queued signal(s): transferId=${transferId}`);
  for (const sig of queue) {
    try {
      peer.signal(sig.data);
    } catch (err) {
      console.warn(`${prefix} Failed to flush queued signal: transferId=${transferId}, fromSocketId=${sig.fromSocketId}, error=${err?.message || err}`);
    }
  }
  _pendingSignals.delete(transferId);
}

function attachPeerConnectionDebug(peer, prefix, meta = {}) {
  const pc = peer?._pc;
  if (!pc) {
    console.warn(`${prefix} RTCPeerConnection missing for debug`, meta);
    return;
  }

  const base = `transferId=${meta.transferId || "unknown"}, remoteSocketId=${meta.remoteSocketId || "unknown"}`;
  const logStates = (tag) => {
    console.log(
      `${prefix} ${tag}: ${base}, signalingState=${pc.signalingState}, iceGatheringState=${pc.iceGatheringState}, ` +
      `iceConnectionState=${pc.iceConnectionState}, connectionState=${pc.connectionState}`,
    );
  };

  logStates("pc-init");
  pc.addEventListener("icegatheringstatechange", () => logStates("icegatheringstatechange"));
  pc.addEventListener("iceconnectionstatechange", () => logStates("iceconnectionstatechange"));
  pc.addEventListener("connectionstatechange", () => logStates("connectionstatechange"));
  pc.addEventListener("signalingstatechange", () => logStates("signalingstatechange"));
}


// ═══════════════════════════════════════════════════════════════════════
//  SENDER
// ═══════════════════════════════════════════════════════════════════════

export function sendFileP2P(socket, roomCode, userName, file, {
  onPeerProgress,
  onComplete,
  onError,
  onDeclined,
} = {}) {
  const transferId = makeTransferId();
  let cancelled = false;
  let finished = false;
  const peers = new Map();
  let totalReceiversDone = 0;
  let expectedReceivers = 0;

  socket.emit("file-offer", {
    roomCode,
    transferId,
    fileName: file.name,
    fileSize: file.size,
    fileType: file.type || "application/octet-stream",
    senderName: userName,
  });

  const onAccept = ({ receiverSocketId, transferId: tid }) => {
    if (tid !== transferId || cancelled) return;
    if (peers.has(receiverSocketId)) {
      console.warn(`[P2P Sender] Duplicate file-accept ignored: transferId=${tid}, receiverSocketId=${receiverSocketId}`);
      return;
    }
    expectedReceivers++;
    console.log(`[P2P Sender] Receiver accepted: ${receiverSocketId}`);
    createSenderPeer(receiverSocketId);
  };

  const onDecline = ({ transferId: tid }) => {
    if (tid !== transferId) return;
    onDeclined?.();
  };

  const onTimeout = ({ transferId: tid }) => {
    if (tid !== transferId) return;
  };

  function createSenderPeer(receiverSocketId) {
    const peer = new Peer({
      initiator: true,
      trickle: true,
      allowHalfOpen: true,  // CRITICAL: prevents Duplex stream _onFinish from auto-destroying
      config: { iceServers: ICE_SERVERS },
      iceTransportPolicy: "all",
    });

     const connectionTimeout = setTimeout(() => {
       if (!peer.destroyed && (!peer._pc || peer._pc.connectionState !== "connected")) {
         console.warn(`[P2P Sender] Connection timeout for ${receiverSocketId}, destroying peer`);
         peerState.timedOut = true;
         try { peer.destroy(); } catch { /* */ }
         peers.delete(receiverSocketId);
         if (!cancelled && !finished) {
           finished = true;
           cleanup();
           onError?.(new Error("TRANSFER_FAILED: WebRTC connection timeout after 30 seconds"));
         }
       }
     }, 30000);

     const peerState = { peer, ackReceived: false, streaming: false, timedOut: false, connectionTimeout };
    peers.set(receiverSocketId, peerState);
    attachPeerConnectionDebug(peer, "[P2P Sender]", {
      transferId,
      remoteSocketId: receiverSocketId,
    });

    peer.on("signal", (data) => {
      console.log(`[P2P Sender] Emitting signal event: transferId=${transferId}, receiverSocketId=${receiverSocketId}, dataType=${data?.type || "unknown"}`);
      if (!cancelled) {
        socket.emit("file-signal", {
          targetSocketId: receiverSocketId,
          transferId,
          data,
        });
      }
    });

    if (typeof peer._onConnectionStateChange === "function") {
      const originalOnConnectionStateChange = peer._onConnectionStateChange.bind(peer);
      peer._onConnectionStateChange = (...args) => {
        try {
          return originalOnConnectionStateChange(...args);
        } catch (err) {
          console.error(`[P2P Sender] _onConnectionStateChange crashed: transferId=${transferId}, receiverSocketId=${receiverSocketId}, error=${err?.message || err}`);
          if (!cancelled && !finished) {
            onError?.(new Error(`TRANSFER_FAILED: ${err?.message || "Connection state failure"}`));
          }
          return undefined;
        }
      };
    }

    peer.on("connect", () => {
      console.log(`[P2P Sender] DataChannel open to ${receiverSocketId}, waiting for READY signal`);
      clearTimeout(peerState.connectionTimeout);
    });

    peer.on("data", (msg) => {
      handleSenderData(msg, peer, peerState, receiverSocketId);
    });

    peer.on("error", (err) => {
      const errorMsg = err?.message || String(err);
      console.error(`[P2P Sender] Peer error for ${receiverSocketId}:`, errorMsg);
      console.error(`[P2P Sender] Error ICE state:`, {
        iceGatheringState: peer._pc?.iceGatheringState,
        iceConnectionState: peer._pc?.iceConnectionState,
        connectionState: peer._pc?.connectionState,
      });
      if (!cancelled && !finished) {
        onError?.(new Error(`TRANSFER_FAILED: ${errorMsg}`));
      }
      peers.delete(receiverSocketId);
    });

    peer.on("close", () => {
      peers.delete(receiverSocketId);
    });
  }

  function handleSenderData(msg, peer, peerState, receiverSocketId) {
    let parsed;
    try {
      const str = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
      parsed = JSON.parse(str);
    } catch {
      return;
    }

    if (parsed.t === "ready" && !peerState.streaming) {
      console.log("[P2P Sender] Receiver READY, starting stream");
      peerState.streaming = true;
      streamFileToPeer(peer, peerState, receiverSocketId);
    }

    if (parsed.t === "transfer-complete" && parsed.transferId === transferId) {
      console.log("[P2P Sender] Got ACK from receiver — transfer complete!");
      peerState.ackReceived = true;
      totalReceiversDone++;
      setTimeout(() => {
        try { peer.destroy(); } catch { /* */ }
        peers.delete(receiverSocketId);
      }, 2000);
      checkAllDone();
    }
  }

  async function streamFileToPeer(peer, peerState, receiverSocketId) {
    if (cancelled || peer.destroyed) return;

    const channel = peer._channel;
    if (!channel || channel.readyState !== "open") {
      if (!cancelled && !finished) onError?.(new Error("DataChannel not open"));
      return;
    }

    try {
      console.log(`[P2P Sender] Sending file-meta: ${file.name} (${file.size} bytes)`);
      safeSend(peer, JSON.stringify({
        t: "file-meta",
        transferId,
        name: file.name,
        size: file.size,
        type: file.type || "application/octet-stream",
      }));

      const totalSize = file.size;
      let sentBytes = 0;
      let offset = 0;

      while (offset < totalSize) {
        if (cancelled || peer.destroyed) {
          safeSend(peer, JSON.stringify({ t: "file-cancel", transferId }));
          return;
        }

        const end = Math.min(offset + CHUNK_SIZE, totalSize);
        const slice = file.slice(offset, end);
        const chunk = await slice.arrayBuffer();

        // BACKPRESSURE
        if (channel.bufferedAmount > BUFFERED_AMOUNT_HIGH) {
          try {
            await waitForBufferDrain(channel);
          } catch {
            if (!cancelled && !finished) onError?.(new Error("Connection lost during transfer"));
            return;
          }
        }

        if (!channel || channel.readyState !== "open" || peer.destroyed) {
          if (!cancelled && !finished) onError?.(new Error("Connection lost during transfer"));
          return;
        }

        if (!safeSend(peer, chunk)) {
          if (!cancelled && !finished) onError?.(new Error("Failed to send chunk"));
          return;
        }

        sentBytes += chunk.byteLength;
        offset = end;

        const pct = Math.round((sentBytes / totalSize) * 100);
        if (pct % 10 === 0 || offset >= totalSize) {
          console.log(`[P2P Sender] Progress: ${pct}% (${sentBytes}/${totalSize})`);
        }

        onPeerProgress?.(receiverSocketId, sentBytes, totalSize);
      }

      console.log("[P2P Sender] All chunks sent, sending file-end marker");
      safeSend(peer, JSON.stringify({ t: "file-end", transferId }));

      // 120s ACK timeout
      setTimeout(() => {
        if (!peerState.ackReceived && !peer.destroyed) {
          console.warn("[P2P Sender] No ACK after 120s, closing.");
          totalReceiversDone++;
          try { peer.destroy(); } catch { /* */ }
          peers.delete(receiverSocketId);
          checkAllDone();
        }
      }, 120_000);

    } catch (err) {
      if (!cancelled && !finished) {
        onError?.(err);
      }
    }
  }

  const onSignal = ({ fromSocketId, transferId: tid, data }) => {
    if (tid !== transferId) return;
    const ps = peers.get(fromSocketId);
    if (ps?.peer && !ps.peer.destroyed) {
      try { ps.peer.signal(data); } catch { /* */ }
    } else {
      console.warn(`[P2P Sender] Signal dropped: missing sender peer mapping. transferId=${tid}, fromSocketId=${fromSocketId}, peerExists=${!!ps?.peer}, peerDestroyed=${ps?.peer?.destroyed === true}`);
    }
  };

  socket.on("file-accept", onAccept);
  socket.on("file-decline", onDecline);
  socket.on("file-timeout", onTimeout);
  socket.on("file-signal", onSignal);

  function checkAllDone() {
    if (finished) return;
    if (totalReceiversDone >= expectedReceivers && expectedReceivers > 0) {
      finished = true;
      cleanup();
      onComplete?.();
    }
  }

  const acceptTimer = setTimeout(() => {
    if (expectedReceivers === 0 && !cancelled && !finished) {
      finished = true;
      cleanup();
      onError?.(new Error("No peers accepted the file transfer."));
    }
  }, OFFER_TIMEOUT_MS);

  function cleanup() {
    clearTimeout(acceptTimer);
    socket.off("file-accept", onAccept);
    socket.off("file-decline", onDecline);
    socket.off("file-timeout", onTimeout);
    socket.off("file-signal", onSignal);
  }

  function cancel() {
    cancelled = true;
    for (const ps of peers.values()) {
      safeSend(ps.peer, JSON.stringify({ t: "file-cancel", transferId }));
      setTimeout(() => { try { ps.peer.destroy(); } catch { /* */ } }, 500);
    }
    cleanup();
    peers.clear();
  }

  return { cancel, transferId };
}


// ═══════════════════════════════════════════════════════════════════════
//  RECEIVER
// ═══════════════════════════════════════════════════════════════════════

/**
 * Set up listeners for incoming file offers.
 *
 * IMPORTANT: Peer state is stored at MODULE LEVEL (`_activePeers`, `_pendingOffers`)
 * so that React StrictMode's effect double-fire doesn't destroy active transfers.
 * The `destroy()` function only removes socket listeners — it NEVER kills peers.
 */
export function setupFileReceiver(socket, {
  onFileOffer,
  onReceiveStart,
  onProgress,
  onComplete,
  onError,
  onStorageError,
} = {}) {

  // ─── Callbacks ref (updated each time the effect re-runs) ───
  const callbacks = { onFileOffer, onReceiveStart, onProgress, onComplete, onError, onStorageError };

  const onOffer = (payload) => {
    const { transferId, fileName, fileSize, fileType, senderName, senderSocketId } = payload;
    if (!transferId || !senderSocketId) return;
    _pendingOffers.set(transferId, payload);
    callbacks.onFileOffer?.({ transferId, fileName, fileSize, fileType, senderName, senderSocketId });
  };

  async function acceptOffer(transferId) {
    const offer = _pendingOffers.get(transferId);
    if (!offer) return;
    _pendingOffers.delete(transferId);

  console.log(`[P2P Receiver] acceptOffer called for transferId=${transferId}, senderSocketId=${offer.senderSocketId}`);
    const { senderSocketId, fileName, fileSize, fileType, senderName } = offer;

    // 1. Storage check
    const quota = await checkStorageQuota(fileSize);
    if (!quota.ok) {
      callbacks.onStorageError?.(transferId, {
        required: fileSize,
        available: quota.available,
        message: `Insufficient storage. Need ${formatBytes(fileSize)}, only ${formatBytes(quota.available)} available.`,
      });
      socket.emit("file-decline", { senderSocketId, transferId, reason: "insufficient-storage" });
      return;
    }

    // 2. File System Access API
    let writable = null;
    let fileHandle = null;
    if (hasFileSystemAccess()) {
      try {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: fileName,
        });
        writable = await fileHandle.createWritable();
        console.log("[P2P Receiver] Got file handle, using DISK mode");
      } catch (err) {
        if (err?.name === "AbortError") {
          socket.emit("file-decline", { senderSocketId, transferId, reason: "save-cancelled" });
          return;
        }
        console.warn("[P2P Receiver] showSaveFilePicker failed, using MEMORY fallback:", err.message);
        writable = null;
      }
    } else {
      console.log("[P2P Receiver] File System Access API not available, using MEMORY mode");
    }

    // 3. Initialize receiver peer FIRST to avoid missing early offer/candidate signals.
    // Write queue: serialize all incoming data processing
    let writeQueuePromise = Promise.resolve();

    // 4. Create peer
    const peer = new Peer({
      initiator: false,
      trickle: true,
      allowHalfOpen: true,  // CRITICAL: prevents Duplex stream _onFinish from auto-destroying
      config: { iceServers: ICE_SERVERS },
      iceTransportPolicy: "all",
    });

    console.log(`[P2P Receiver] Peer created: initiator=false, transferId=${transferId}`);
    const state = {
      peer,
      meta: null,
      writable,
      chunks: writable ? null : [],
      receivedBytes: 0,
      senderSocketId,
      senderName: senderName || "Peer",
      mode: writable ? "disk" : "memory",
      finished: false,
      _fileHandle: fileHandle,  // for re-reading saved file after transfer
    };
    attachPeerConnectionDebug(peer, "[P2P Receiver]", {
      transferId,
      remoteSocketId: senderSocketId,
    });

    if (typeof peer._onConnectionStateChange === "function") {
      const originalOnConnectionStateChange = peer._onConnectionStateChange.bind(peer);
      peer._onConnectionStateChange = (...args) => {
        try {
          return originalOnConnectionStateChange(...args);
        } catch (err) {
          console.error(`[P2P Receiver] _onConnectionStateChange crashed: transferId=${transferId}, senderSocketId=${senderSocketId}, error=${err?.message || err}`);
          if (!state.finished) {
            state.finished = true;
            cleanupPeer(transferId, state);
            callbacks.onError?.(transferId, new Error(`TRANSFER_FAILED: ${err?.message || "Connection state failure"}`));
          }
          return undefined;
        }
      };
    }

    // Store at MODULE level — survives React StrictMode effect re-fires
    _activePeers.set(transferId, state);
    flushPendingSignals(transferId, peer);

    // 4. Accept only after receiver peer is fully ready.
    console.log(`[P2P Receiver] Accepting transfer ${transferId}`);
    socket.emit("file-accept", { senderSocketId, transferId });

    console.log(`[P2P Receiver] Peer state stored in _activePeers: transferId=${transferId}, stateKeys=${Object.keys(state).filter((k) => k !== "writable" && k !== "_fileHandle").join(",")}`);
    const connectionTimeout = setTimeout(() => {
      if (!peer.destroyed && (!peer._pc || peer._pc.connectionState !== "connected")) {
        console.warn(`[P2P Receiver] Connection timeout for ${transferId}, destroying peer`);
        state.timedOut = true;
        try { peer.destroy(); } catch { /* */ }
        _activePeers.delete(transferId);
        callbacks.onError?.(transferId, new Error("TRANSFER_FAILED: WebRTC connection timeout after 30 seconds"));
      }
    }, 30000);
    state.connectionTimeout = connectionTimeout;

    peer.on("signal", (data) => {
      console.log(`[P2P Receiver] Emitting signal back to sender: transferId=${transferId}, senderSocketId=${state.senderSocketId}, dataType=${data?.type || "unknown"}`);
      socket.emit("file-signal", {
        targetSocketId: senderSocketId,
        transferId,
        data,
      });
    });

    peer.on("connect", () => {
      console.log(`[P2P Receiver] DataChannel OPEN, sending READY signal`);
      clearTimeout(state.connectionTimeout);
      safeSend(peer, JSON.stringify({ t: "ready" }));
    });

    peer.on("data", (data) => {
      // Serialize all data processing through promise chain
      writeQueuePromise = writeQueuePromise.then(() =>
        handleIncomingData(transferId, state, peer, data, callbacks)
      ).catch((err) => {
        console.error("[P2P Receiver] Write queue error:", err.message);
        if (!state.finished) {
          state.finished = true;
          cleanupPeer(transferId, state);
          callbacks.onError?.(transferId, err);
        }
      });
    });

    peer.on("error", (err) => {
      if (!state.finished) {
        const errorMsg = err?.message || String(err);
        console.error(`[P2P Receiver] Peer error for ${transferId}:`, errorMsg);
        state.finished = true;
        cleanupPeer(transferId, state);
        callbacks.onError?.(transferId, new Error(`TRANSFER_FAILED: ${errorMsg}`));
      }
    });

    peer.on("close", () => {
      console.log(`[P2P Receiver] Peer closed for ${transferId}`);
      _activePeers.delete(transferId);
    });
  }

  function declineOffer(transferId) {
    const offer = _pendingOffers.get(transferId);
    if (!offer) return;
    _pendingOffers.delete(transferId);
    socket.emit("file-decline", {
      senderSocketId: offer.senderSocketId,
      transferId,
      reason: "declined",
    });
  }

  // ─── Signaling relay (uses module-level _activePeers) ───
  const onSignal = ({ fromSocketId, transferId, data }) => {
    const state = _activePeers.get(transferId);
    const hasPendingOffer = _pendingOffers.has(transferId);
    if (!state?.peer || state.peer.destroyed) {
      if (!hasPendingOffer) {
        console.warn(
          `[P2P Receiver] Ignoring unrelated signal: transferId=${transferId}, fromSocketId=${fromSocketId}, ` +
          `stateExists=${!!state}, hasPendingOffer=${hasPendingOffer}, dataType=${data?.type || "unknown"}`,
        );
        return;
      }
      const queued = queuePendingSignal(transferId, { fromSocketId, data });
      console.warn(
        `[P2P Receiver] Signal queued (peer not ready): transferId=${transferId}, fromSocketId=${fromSocketId}, ` +
        `stateExists=${!!state}, peerExists=${!!state?.peer}, peerDestroyed=${state?.peer?.destroyed === true}, ` +
        `hasPendingOffer=${hasPendingOffer}, queuedCount=${queued}, dataType=${data?.type || "unknown"}`,
      );
      return;
    }
    console.log(`[P2P Receiver] Relaying signal to peer: transferId=${transferId}, fromSocketId=${fromSocketId}, dataType=${data?.type || "unknown"}, peerExists=${!!state?.peer}, peerDestroyed=${state.peer.destroyed === true}`);
    try {
      state.peer.signal(data);
    } catch (err) {
      console.warn(`[P2P Receiver] peer.signal failed: transferId=${transferId}, fromSocketId=${fromSocketId}, error=${err?.message || err}`);
    }
  };

  socket.on("file-offer", onOffer);
  socket.on("file-signal", onSignal);

  console.log("[P2P Receiver] Socket listeners registered for file-offer and file-signal");
  /**
   * destroy() — called by React effect cleanup.
   * ONLY removes socket listeners. NEVER destroys active peers.
   * This is what makes us StrictMode-safe.
   */
  function destroy() {
    console.log("[P2P Receiver] destroy() called — removing socket listeners only (peers preserved)");
    socket.off("file-offer", onOffer);
    socket.off("file-signal", onSignal);
    // DO NOT touch _activePeers, _pendingOffers, or _pendingSignals — they must survive re-fires
  }

  return { destroy, acceptOffer, declineOffer };
}


// ─── Data handling (standalone functions, not tied to effect lifecycle) ───

async function handleIncomingData(transferId, state, peer, data, callbacks) {
  if (state.finished) return;

  // simple-peer pushes ALL messages through a Node Readable stream,
  // converting everything (including strings) to Buffer/Uint8Array.
  // We must attempt JSON decode on EVERY message to detect control messages.
  let controlMsg = null;
  try {
    const str = typeof data === "string"
      ? data
      : new TextDecoder().decode(data);
    controlMsg = JSON.parse(str);
  } catch {
    // Not JSON — it's a binary file chunk
    controlMsg = null;
  }

  // ─── Control messages ───
  if (controlMsg && controlMsg.t) {
    if (controlMsg.t === "file-meta") {
      state.meta = { name: controlMsg.name, size: controlMsg.size, type: controlMsg.type };
      state.receivedBytes = 0;
      console.log(`[P2P Receiver] Got file-meta: ${controlMsg.name} (${controlMsg.size} bytes), mode: ${state.mode}`);
      callbacks.onReceiveStart?.({ transferId, fileName: controlMsg.name, fileSize: controlMsg.size, senderName: state.senderName });
      return;
    }
    if (controlMsg.t === "file-end") {
      console.log(`[P2P Receiver] Got file-end, finishing transfer...`);
      await finishTransfer(transferId, state, peer, callbacks);
      return;
    }
    if (controlMsg.t === "file-cancel") {
      state.finished = true;
      cleanupPeer(transferId, state);
      callbacks.onError?.(transferId, new Error("Sender cancelled the transfer"));
      return;
    }
    // Unknown control message — ignore
    return;
  }

  // ─── Binary file chunk ───
  if (!state.meta) return;

  const u8 = data instanceof Uint8Array
    ? data
    : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer || data);

  if (state.mode === "disk" && state.writable) {
    try {
      await state.writable.write(u8);
    } catch (err) {
      console.warn("[P2P Receiver] Disk write failed, falling back to memory:", err.message);
      state.mode = "memory";
      state.chunks = [u8];
      try { await state.writable.abort(); } catch { /* */ }
      state.writable = null;
    }
  } else {
    if (!state.chunks) state.chunks = [];
    state.chunks.push(u8);
  }

  state.receivedBytes += u8.byteLength;

  // Log progress every ~10%
  if (state.meta.size > 0) {
    const pct = Math.round((state.receivedBytes / state.meta.size) * 100);
    if (pct % 10 === 0) {
      console.log(`[P2P Receiver] Progress: ${pct}% (${state.receivedBytes}/${state.meta.size})`);
    }
  }

  callbacks.onProgress?.(transferId, state.receivedBytes, state.meta.size);
}


async function finishTransfer(transferId, state, peer, callbacks) {
  if (state.finished) return;
  state.finished = true;

  try {
    if (state.mode === "disk" && state.writable) {
      console.log("[P2P Receiver] Closing writable (disk mode)...");
      await state.writable.close();
      state.writable = null;

      // Read the saved file back from the handle to create a blob URL for "Open File"
      let url = null;
      let blob = null;
      if (state._fileHandle) {
        try {
          const savedFile = await state._fileHandle.getFile();
          blob = savedFile;
          url = URL.createObjectURL(savedFile);
          console.log("[P2P Receiver] Re-read saved file for Open File URL");
        } catch (err) {
          console.warn("[P2P Receiver] Could not re-read saved file:", err.message);
        }
      }

      console.log("[P2P Receiver] Sending ACK to sender");
      safeSend(peer, JSON.stringify({ t: "transfer-complete", transferId }));

      callbacks.onComplete?.(transferId, {
        name: state.meta.name,
        size: state.meta.size,
        type: state.meta.type,
        savedToDisk: true,
        blob,
        url,
      });
    } else {
      console.log("[P2P Receiver] Assembling blob (memory mode)...");
      const blob = new Blob(state.chunks || [], {
        type: state.meta?.type || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);

      console.log("[P2P Receiver] Sending ACK to sender");
      safeSend(peer, JSON.stringify({ t: "transfer-complete", transferId }));

      triggerDownload(url, state.meta?.name);

      callbacks.onComplete?.(transferId, {
        name: state.meta?.name,
        size: state.meta?.size,
        type: state.meta?.type,
        savedToDisk: false,
        blob,
        url,
      });
    }
  } catch (err) {
    console.error("[P2P Receiver] finishTransfer error:", err.message);
    callbacks.onError?.(transferId, err);
  }

  // Graceful teardown
  setTimeout(() => {
    cleanupPeer(transferId, state);
  }, 3000);
}

function cleanupPeer(transferId, state) {
  if (state.writable) {
    try { state.writable.abort(); } catch { /* */ }
    state.writable = null;
  }
  if (state.peer && !state.peer.destroyed) {
    try { state.peer.destroy(); } catch { /* */ }
  }
  state.chunks = null;
  _activePeers.delete(transferId);
}


// ─── Download Helper ─────────────────────────────────────────────────

export function triggerDownload(url, filename) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename || "download";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 60_000);
}
