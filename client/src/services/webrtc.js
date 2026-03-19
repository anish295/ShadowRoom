// simple-peer is CJS (module.exports = Peer). Handle ESM interop so .default isn't undefined.
import * as SimplePeerNamespace from "simple-peer";
const Peer = SimplePeerNamespace.default ?? SimplePeerNamespace;
if (typeof Peer !== "function") {
  throw new Error("simple-peer: constructor not found. Try clearing node_modules/.vite and restarting the dev server.");
}

const CHUNK_SIZE = 64 * 1024; // 64KB
const MAX_BUFFERED_AMOUNT = 1 * 1024 * 1024; // 1MB soft limit

const STUN_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function makeId() {
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function canUseFileSystemAccessApi() {
  return typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
}

/**
 * Message protocol over datachannel:
 * - JSON strings for control messages.
 * - Binary ArrayBuffer for file bytes, preceded by JSON header per-chunk.
 *
 * Control messages:
 * - { t:"clipboard", text, ts }
 * - { t:"file-meta", id, name, size, type, lastModified }
 * - { t:"file-chunk", id, seq, bytes }  // bytes = chunk.byteLength (next message is binary)
 * - { t:"file-end", id, totalChunks }
 * - { t:"file-cancel", id, reason? }
 */

export function createWebRtcSession({
  initiator,
  signaling,
  pin,
  onStatus,
  onClipboard,
  onTransferEvent,
} = {}) {
  let destroyed = false;

  /** @type {Peer|null} */
  let peer = null;

  // Receiving state for current/ongoing file(s)
  /** @type {Map<string, any>} */
  const incoming = new Map();
  /** @type {{expectingBinaryForId:string|null, expectingSeq:number|null}} */
  const binaryLatch = { expectingBinaryForId: null, expectingSeq: null };

  /** @type {Map<string, {cancelled:boolean}>} */
  const outgoing = new Map();

  const emitStatus = (s) => onStatus?.(s);

  const getChannel = () => peer?._channel;
  const isChannelOpen = () => {
    const ch = getChannel();
    return ch && ch.readyState === "open";
  };

  const getBufferedAmount = () => {
    const ch = getChannel();
    return typeof ch?.bufferedAmount === "number" ? ch.bufferedAmount : 0;
  };

  const waitForChannelOpen = async () => {
    const deadline = Date.now() + 5000;
    while (!destroyed && peer && !isChannelOpen() && Date.now() < deadline) {
      await sleep(50);
    }
    if (!isChannelOpen()) throw new Error("Data channel not ready. Wait a moment and try again.");
  };

  const waitForBufferLow = async () => {
    while (!destroyed && peer && getBufferedAmount() > MAX_BUFFERED_AMOUNT) {
      await sleep(15);
    }
  };

  const sendJson = async (obj) => {
    if (!peer || destroyed) return;
    await waitForChannelOpen();
    await waitForBufferLow();
    peer.send(JSON.stringify(obj));
  };

  const sendBinary = async (ab) => {
    if (!peer || destroyed) return;
    await waitForChannelOpen();
    await waitForBufferLow();
    peer.send(ab);
  };

  const cancelTransfer = async (id, reason = "cancelled") => {
    if (!id) return;
    const out = outgoing.get(id);
    if (out) out.cancelled = true;
    const inc = incoming.get(id);
    if (inc) {
      try {
        await inc.writer?.close?.();
      } catch {
        // ignore
      }
      incoming.delete(id);
      onTransferEvent?.({
        type: "file-receive-cancelled",
        id,
        name: inc.meta?.name,
        size: inc.meta?.size,
        reason,
      });
    }
    // Inform peer so they can discard partially received chunks.
    await sendJson({ t: "file-cancel", id, reason });
  };

  const saveIncomingToDisk = async (id) => {
    const entry = incoming.get(id);
    if (!entry) throw new Error("No incoming transfer.");
    if (!canUseFileSystemAccessApi()) throw new Error("Save-to-device not supported in this browser.");
    if (entry.mode === "stream") return;

    const suggestedName = entry.meta?.name || "download.bin";
    const handle = await window.showSaveFilePicker({
      suggestedName,
      types: entry.meta?.type
        ? [
            {
              description: entry.meta.type,
              accept: { [entry.meta.type]: [".*"] },
            },
          ]
        : undefined,
    });
    const writable = await handle.createWritable();
    entry.mode = "stream";
    entry.handle = handle;
    entry.writer = writable;

    // Flush already-received chunks to disk, then free memory.
    if (entry.chunks?.length) {
      for (const part of entry.chunks) {
        await writable.write(part);
      }
      entry.chunks = [];
    }

    onTransferEvent?.({ type: "file-receive-save-enabled", id });
  };

  const setupPeer = () => {
    peer = new Peer({
      initiator: !!initiator,
      trickle: true,
      config: { iceServers: STUN_SERVERS },
    });

    peer.on("signal", (data) => {
      signaling.sendSignal({ pin, data });
    });

    peer.on("connect", () => {
      emitStatus("connected");
      onTransferEvent?.({ type: "system", message: "Peer connected." });
    });

    peer.on("close", () => {
      emitStatus("disconnected");
      onTransferEvent?.({ type: "system", message: "Peer disconnected." });
    });

    peer.on("error", (err) => {
      emitStatus("error");
      onTransferEvent?.({ type: "system", message: err?.message || "WebRTC error." });
    });

    peer.on("data", async (data) => {
      // data can be string or Buffer/Uint8Array (browser may deliver JSON as binary)
      let str = null;
      if (typeof data === "string") {
        str = data;
      } else if (
        data instanceof ArrayBuffer ||
        data instanceof Uint8Array ||
        (data && data.buffer instanceof ArrayBuffer)
      ) {
        // JSON can arrive as binary in some environments; only decode if not expecting file chunk
        const expectingBinary = binaryLatch.expectingBinaryForId != null;
        if (!expectingBinary) {
          try {
            const u8 =
              data instanceof Uint8Array
                ? data
                : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
            str = new TextDecoder().decode(u8);
          } catch {
            // ignore
          }
        }
      }

      if (str != null) {
        const msg = safeJsonParse(str);
        if (!msg?.t) return;

        if (msg.t === "clipboard") {
          onClipboard?.({ text: msg.text ?? "", ts: msg.ts ?? Date.now() });
          return;
        }

        if (msg.t === "file-meta") {
          incoming.set(msg.id, {
            meta: msg,
            receivedBytes: 0,
            chunks: [],
            expectedSeq: 0,
            startedAt: Date.now(),
            mode: "memory", // or "stream"
            writer: null,
            handle: null,
          });
          onTransferEvent?.({
            type: "file-receive-start",
            id: msg.id,
            name: msg.name,
            size: msg.size,
            mime: msg.type,
            canSaveToDisk: canUseFileSystemAccessApi(),
          });
          return;
        }

        if (msg.t === "file-chunk") {
          // Next message should be binary for this id/seq.
          binaryLatch.expectingBinaryForId = msg.id;
          binaryLatch.expectingSeq = msg.seq;
          return;
        }

        if (msg.t === "file-end") {
          const entry = incoming.get(msg.id);
          if (!entry) return;

          if (entry.mode === "stream" && entry.writer) {
            try {
              await entry.writer.close();
            } catch {
              // ignore
            }
            onTransferEvent?.({
              type: "file-receive-complete",
              id: msg.id,
              name: entry.meta.name,
              size: entry.meta.size,
              mime: entry.meta.type,
              savedToDisk: true,
              durationMs: Date.now() - entry.startedAt,
            });
          } else {
            // Assemble Blob and emit.
            const blob = new Blob(entry.chunks, { type: entry.meta.type || "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            onTransferEvent?.({
              type: "file-receive-complete",
              id: msg.id,
              name: entry.meta.name,
              size: entry.meta.size,
              mime: entry.meta.type,
              url,
              blob,
              savedToDisk: false,
              durationMs: Date.now() - entry.startedAt,
            });
          }

          incoming.delete(msg.id);
          binaryLatch.expectingBinaryForId = null;
          binaryLatch.expectingSeq = null;
          return;
        }

        if (msg.t === "file-cancel") {
          const out = outgoing.get(msg.id);
          if (out) {
            out.cancelled = true;
            onTransferEvent?.({
              type: "file-send-cancelled",
              id: msg.id,
              reason: msg.reason || "cancelled",
            });
          }

          const entry = incoming.get(msg.id);
          if (entry) {
            try {
              await entry.writer?.close?.();
            } catch {
              // ignore
            }
            incoming.delete(msg.id);
            onTransferEvent?.({
              type: "file-receive-cancelled",
              id: msg.id,
              name: entry.meta?.name,
              size: entry.meta?.size,
              reason: msg.reason || "cancelled",
            });
          }
          if (binaryLatch.expectingBinaryForId === msg.id) {
            binaryLatch.expectingBinaryForId = null;
            binaryLatch.expectingSeq = null;
          }
          return;
        }

        return;
      }

      // Binary path (Buffer/Uint8Array) – only when expecting a file chunk
      const id = binaryLatch.expectingBinaryForId;
      const seq = binaryLatch.expectingSeq;
      if (!id || typeof seq !== "number") return;
      if (typeof data === "string") return;

      const entry = incoming.get(id);
      if (!entry) return;

      const u8 = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
      if (entry.mode === "stream" && entry.writer) {
        try {
          await entry.writer.write(u8);
        } catch {
          // If disk write fails, fall back to memory to keep transfer alive.
          entry.mode = "memory";
          entry.writer = null;
          entry.chunks.push(u8);
        }
      } else {
        entry.chunks.push(u8);
      }
      entry.receivedBytes += u8.byteLength;
      entry.expectedSeq = seq + 1;

      onTransferEvent?.({
        type: "file-receive-progress",
        id,
        receivedBytes: entry.receivedBytes,
        totalBytes: entry.meta.size,
      });

      binaryLatch.expectingBinaryForId = null;
      binaryLatch.expectingSeq = null;
    });

    // Signaling wiring
    const offSignal = signaling.on("webrtc:signal", ({ data }) => {
      try {
        peer?.signal(data);
      } catch {
        // ignore
      }
    });

    const offPeerDisconnected = signaling.on("peer:disconnected", () => {
      emitStatus("disconnected");
      onTransferEvent?.({ type: "system", message: "Peer disconnected." });
      try {
        peer?.destroy();
      } catch {
        // ignore
      }
    });

    return () => {
      offSignal?.();
      offPeerDisconnected?.();
    };
  };

  let teardownSignaling = null;
  emitStatus("connecting");
  teardownSignaling = setupPeer();

  const destroy = () => {
    destroyed = true;
    try {
      teardownSignaling?.();
    } catch {
      // ignore
    }
    teardownSignaling = null;
    try {
      peer?.destroy();
    } catch {
      // ignore
    }
    peer = null;
  };

  const sendClipboard = async (text) => {
    await sendJson({ t: "clipboard", text: String(text ?? ""), ts: Date.now() });
  };

  const sendFile = async (file) => {
    if (!file) return;
    const id = makeId();
    outgoing.set(id, { cancelled: false });
    const meta = {
      t: "file-meta",
      id,
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified,
    };

    onTransferEvent?.({ type: "file-send-start", id, name: file.name, size: file.size, mime: file.type });
    await sendJson(meta);

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let sentBytes = 0;
    const startedAt = Date.now();

    try {
      for (let seq = 0; seq < totalChunks; seq++) {
        if (destroyed) throw new Error("Session ended");
        if (outgoing.get(id)?.cancelled) {
          await sendJson({ t: "file-cancel", id, reason: "cancelled" });
          onTransferEvent?.({
            type: "file-send-cancelled",
            id,
            name: file.name,
            size: file.size,
            mime: file.type,
            sentBytes,
          });
          return;
        }

        const start = seq * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        const slice = file.slice(start, end);
        const ab = await slice.arrayBuffer();

        await sendJson({ t: "file-chunk", id, seq, bytes: ab.byteLength });
        await sendBinary(ab);

        sentBytes += ab.byteLength;
        onTransferEvent?.({
          type: "file-send-progress",
          id,
          sentBytes,
          totalBytes: file.size,
        });
      }

      await sendJson({ t: "file-end", id, totalChunks });
      onTransferEvent?.({
        type: "file-send-complete",
        id,
        name: file.name,
        size: file.size,
        mime: file.type,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      onTransferEvent?.({
        type: "file-send-failed",
        id,
        name: file.name,
        size: file.size,
        mime: file.type,
        sentBytes,
        error: err?.message || "send failed",
      });
      throw err;
    } finally {
      outgoing.delete(id);
    }
  };

  return {
    destroy,
    sendClipboard,
    sendFile,
    cancelTransfer,
    saveIncomingToDisk,
  };
}

