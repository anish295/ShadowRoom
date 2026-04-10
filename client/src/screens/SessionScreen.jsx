import React, { useEffect, useMemo, useRef, useState } from "react";
import ProgressBar from "../components/ProgressBar.jsx";
import TransferHistory from "../components/TransferHistory.jsx";
import { createWebRtcSession } from "../services/webrtc.js";

function clampPin(pin) {
  return String(pin || "").replace(/\D/g, "").slice(0, 6);
}

function shortPreview(s) {
  const t = String(s ?? "");
  const oneLine = t.replace(/\s+/g, " ").trim();
  return oneLine.length > 90 ? `${oneLine.slice(0, 90)}…` : oneLine;
}

function formatBytes(n) {
  const x = Number(n || 0);
  if (x < 1024) return `${x} B`;
  const kb = x / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

export default function SessionScreen({ signaling, pin, mode, onError, onExit }) {
  const normalizedPin = useMemo(() => clampPin(pin), [pin]);
  const isInitiator = mode === "sender";

  const [status, setStatus] = useState("waiting");
  const [peerReady, setPeerReady] = useState(false);

  const [clipboardText, setClipboardText] = useState("");
  const lastRemoteTsRef = useRef(0);
  const ignoreNextLocalRef = useRef(false);
  const clipboardLogThrottleRef = useRef({ inTs: 0, outTs: 0 });

  const [history, setHistory] = useState([]);

  const [sendProgress, setSendProgress] = useState(null);
  const [recvProgress, setRecvProgress] = useState(null);

  const sessionRef = useRef(null);
  const pendingSendFileRef = useRef(null);
  const outgoingFilesRef = useRef(new Map());
  const receivedUrlsRef = useRef(new Set());
  const incomingCanSaveRef = useRef(new Map());

  const pushHistory = (item) =>
    setHistory((prev) => [{ key: `${Date.now()}-${Math.random()}`, ...item }, ...prev].slice(0, 50));

  const upsertFileHistory = ({ id, direction, name, size, progress, url }) => {
    const key = `file-${direction}-${id}`;
    setHistory((prev) => {
      const idx = prev.findIndex((x) => x.key === key);
      const nextItem = {
        key,
        kind: "file",
        direction,
        id,
        name,
        size,
        status: progress === 1 ? "complete" : typeof progress === "number" ? "active" : undefined,
        ...(typeof progress === "number" ? { progress } : {}),
        ...(url ? { url } : {}),
      };
      if (idx === -1) return [nextItem, ...prev].slice(0, 50);
      const copy = prev.slice();
      copy[idx] = { ...copy[idx], ...nextItem };
      return copy;
    });
  };

  const maybeLogClipboard = (direction, text) => {
    const now = Date.now();
    const bucket = direction === "in" ? "inTs" : "outTs";
    if (now - clipboardLogThrottleRef.current[bucket] < 1200) return;
    clipboardLogThrottleRef.current[bucket] = now;
    pushHistory({ kind: "clipboard", direction, preview: shortPreview(text) });
  };

  useEffect(() => {
    const offReady = signaling.on("peer:ready", ({ role }) => {
      setPeerReady(true);
      setStatus("connecting");
      pushHistory({ kind: "system", direction: "system", message: `Peer ready (${role || "unknown"}).` });
    });

    const offPeerDisconnected = signaling.on("peer:disconnected", () => {
      setStatus("disconnected");
      setPeerReady(false);
      pushHistory({ kind: "system", direction: "system", message: "Peer disconnected." });
    });

    return () => {
      offReady?.();
      offPeerDisconnected?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      for (const url of receivedUrlsRef.current.values()) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
      receivedUrlsRef.current.clear();
    };
  }, []);

  useEffect(() => {
    if (!peerReady) return;

    sessionRef.current?.destroy?.();
    sessionRef.current = createWebRtcSession({
      initiator: isInitiator,
      signaling,
      pin: normalizedPin,
      onStatus: (s) => setStatus(s),
      onClipboard: ({ text, ts }) => {
        if (ts <= lastRemoteTsRef.current) return;
        lastRemoteTsRef.current = ts;
        ignoreNextLocalRef.current = true;
        setClipboardText(text);
        maybeLogClipboard("in", text);
      },
      onTransferEvent: (ev) => {
        if (ev.type === "system") {
          pushHistory({ kind: "system", direction: "system", message: ev.message });
          return;
        }
        if (ev.type === "file-send-start") {
          setSendProgress({ id: ev.id, sentBytes: 0, totalBytes: ev.size, name: ev.name });
          if (pendingSendFileRef.current) outgoingFilesRef.current.set(ev.id, pendingSendFileRef.current);
          pendingSendFileRef.current = null;
          upsertFileHistory({ id: ev.id, direction: "out", name: ev.name, size: ev.size, progress: 0 });
          return;
        }
        if (ev.type === "file-send-progress") {
          setSendProgress((p) => (p && p.id === ev.id ? { ...p, sentBytes: ev.sentBytes } : p));
          upsertFileHistory({ id: ev.id, direction: "out", progress: ev.totalBytes ? ev.sentBytes / ev.totalBytes : 0 });
          return;
        }
        if (ev.type === "file-send-complete") {
          setSendProgress(null);
          upsertFileHistory({ id: ev.id, direction: "out", progress: 1 });
          pushHistory({ kind: "system", direction: "system", message: `Sent ${ev.name} (${formatBytes(ev.size)}).` });
          return;
        }
        if (ev.type === "file-send-cancelled") {
          setSendProgress(null);
          setHistory((prev) => prev.map((it) => it.kind === "file" && it.direction === "out" && it.id === ev.id ? { ...it, status: "cancelled" } : it));
          pushHistory({ kind: "system", direction: "system", message: `Cancelled sending ${ev.name}.` });
          return;
        }
        if (ev.type === "file-send-failed") {
          setSendProgress(null);
          setHistory((prev) => prev.map((it) => it.kind === "file" && it.direction === "out" && it.id === ev.id ? { ...it, status: "failed" } : it));
          pushHistory({ kind: "system", direction: "system", message: `Failed sending ${ev.name}.` });
          return;
        }
        if (ev.type === "file-receive-start") {
          setRecvProgress({ id: ev.id, receivedBytes: 0, totalBytes: ev.size, name: ev.name });
          incomingCanSaveRef.current.set(ev.id, !!ev.canSaveToDisk);
          upsertFileHistory({ id: ev.id, direction: "in", name: ev.name, size: ev.size, progress: 0 });
          return;
        }
        if (ev.type === "file-receive-progress") {
          setRecvProgress((p) => (p && p.id === ev.id ? { ...p, receivedBytes: ev.receivedBytes } : p));
          upsertFileHistory({ id: ev.id, direction: "in", progress: ev.totalBytes ? ev.receivedBytes / ev.totalBytes : 0 });
          return;
        }
        if (ev.type === "file-receive-complete") {
          setRecvProgress(null);
          if (ev.url) receivedUrlsRef.current.add(ev.url);
          upsertFileHistory({ id: ev.id, direction: "in", name: ev.name, size: ev.size, progress: 1, url: ev.url });
          pushHistory({ kind: "system", direction: "system", message: ev.savedToDisk ? `Saved ${ev.name} to device.` : `Received ${ev.name} (${formatBytes(ev.size)}).` });
          return;
        }
        if (ev.type === "file-receive-cancelled") {
          setRecvProgress(null);
          setHistory((prev) => prev.map((it) => it.kind === "file" && it.direction === "in" && it.id === ev.id ? { ...it, status: "cancelled" } : it));
          pushHistory({ kind: "system", direction: "system", message: `Receive cancelled for ${ev.name || "file"}.` });
          incomingCanSaveRef.current.delete(ev.id);
          return;
        }
      },
    });

    return () => {
      sessionRef.current?.destroy?.();
      sessionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerReady, isInitiator, normalizedPin]);

  const canSend = status === "connected";

  const handleClipboardChange = (e) => {
    const text = e.target.value;
    setClipboardText(text);
    if (ignoreNextLocalRef.current) ignoreNextLocalRef.current = false;
  };

  const handleSendClipboard = async () => {
    if (!canSend) { onError("Not connected yet."); return; }
    try {
      maybeLogClipboard("out", clipboardText);
      await sessionRef.current?.sendClipboard?.(clipboardText);
      pushHistory({ kind: "system", direction: "system", message: "Text sent." });
    } catch (err) {
      onError(err?.message || "Failed to send text.");
    }
  };

  const handleCopyReceived = async () => {
    try {
      await navigator.clipboard.writeText(clipboardText);
      pushHistory({ kind: "system", direction: "system", message: "Copied text to clipboard." });
    } catch {
      onError("Copy failed (browser permission).");
    }
  };

  const MAX_FILESIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2GB

  const handleFiles = async (files) => {
    const list = Array.from(files || []);
    if (list.length === 0) return;
    if (!canSend) { onError("Not connected yet."); return; }

    for (const file of list) {
      if (file.size > MAX_FILESIZE_BYTES) {
        onError("File is too large. Maximum file size for transfer is 2GB.");
        return;
      }
    }

    try {
      for (const file of list) {
        pendingSendFileRef.current = file;
        await sessionRef.current?.sendFile?.(file);
      }
    } catch (err) {
      onError(err?.message || "File send failed.");
    }
  };

  const onDrop = async (e) => { e.preventDefault(); e.stopPropagation(); await handleFiles(e.dataTransfer.files); };
  const onDragOver = (e) => { e.preventDefault(); e.stopPropagation(); };

  const cancelActiveSend = async () => {
    const id = sendProgress?.id;
    if (!id) return;
    try {
      await sessionRef.current?.cancelTransfer?.(id, "cancelled");
      setHistory((prev) => prev.map((it) => (it.kind === "file" && it.direction === "out" && it.id === id ? { ...it, status: "cancelled" } : it)));
    } catch { /* ignore */ }
  };

  const cancelActiveReceive = async () => {
    const id = recvProgress?.id;
    if (!id) return;
    try {
      await sessionRef.current?.cancelTransfer?.(id, "receiver_cancelled");
      setHistory((prev) => prev.map((it) => (it.kind === "file" && it.direction === "in" && it.id === id ? { ...it, status: "cancelled" } : it)));
    } catch { /* ignore */ }
  };

  const saveIncoming = async (id) => {
    try {
      await sessionRef.current?.saveIncomingToDisk?.(id);
      pushHistory({ kind: "system", direction: "system", message: "Saving incoming file to device…" });
      setHistory((prev) => prev.map((it) => (it.kind === "file" && it.direction === "in" && it.id === id ? { ...it, status: "saving" } : it)));
    } catch (err) {
      onError(err?.message || "Save failed.");
    }
  };

  const retrySend = async (id) => {
    const file = outgoingFilesRef.current.get(id);
    if (!file) { onError("Retry unavailable (file not in memory)."); return; }
    try {
      pendingSendFileRef.current = file;
      await sessionRef.current?.sendFile?.(file);
    } catch (err) {
      onError(err?.message || "Retry failed.");
    }
  };

  const historyWithActions = useMemo(() => {
    return history.map((it) => {
      if (it.kind !== "file") return it;
      if (it.direction === "out" && it.status === "active") return { ...it, actions: { cancel: cancelActiveSend } };
      if (it.direction === "out" && (it.status === "cancelled" || it.status === "failed")) return { ...it, actions: { retry: () => retrySend(it.id) } };
      if (it.direction === "in" && it.status === "active") {
        const canSave = incomingCanSaveRef.current.get(it.id);
        return { ...it, actions: { cancel: cancelActiveReceive, ...(canSave ? { save: () => saveIncoming(it.id) } : {}) } };
      }
      return it;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, sendProgress?.id]);

  const statusColorClass = status === "connected" ? "connected" : (status === "connecting" || status === "waiting") ? "waiting" : "disconnected";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* Session Header Card */}
      <div className="sr-card">
        <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
            <div style={{
              width: 50, height: 50, borderRadius: 14,
              background: "var(--gradient-1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "white", fontSize: "1.2rem",
              boxShadow: "0 5px 20px var(--accent-glow)"
            }}>
              <i className="fas fa-satellite-dish"></i>
            </div>
            <div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>Session</div>
              <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
                PIN: <span style={{ fontFamily: "'Courier New', monospace", fontWeight: 700, letterSpacing: "0.2em", color: "var(--text-primary)" }}>{normalizedPin}</span>
                <span style={{ margin: "0 0.5rem", color: "var(--text-muted)" }}>·</span>
                Role: <span style={{ fontWeight: 700, color: "var(--text-primary)", textTransform: "capitalize" }}>{mode}</span>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span className={`status-badge ${statusColorClass}`}>
              <i className={`fas ${status === "connected" ? "fa-check-circle" : status === "connecting" || status === "waiting" ? "fa-spinner fa-spin" : "fa-times-circle"}`} style={{ marginRight: "0.4rem", fontSize: "0.7rem" }}></i>
              {status}
            </span>
            <button className="btn btn-secondary" onClick={onExit} style={{ padding: "0.6rem 1.25rem", fontSize: "0.9rem" }}>
              <i className="fas fa-arrow-left"></i>
              Back
            </button>
          </div>
        </div>

        {!peerReady && (
          <div style={{
            marginTop: "1.25rem",
            padding: "1rem 1.25rem",
            background: "var(--bg-tertiary)",
            borderRadius: 12,
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            color: "var(--text-secondary)",
            fontSize: "0.9rem"
          }}>
            <i className="fas fa-spinner fa-spin" style={{ color: "var(--accent)" }}></i>
            Waiting for the other device to join this PIN…
          </div>
        )}
      </div>

      {/* Two column layout */}
      <div style={{ display: "grid", gap: "1.5rem", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {/* Shared Clipboard Card */}
          <div className="sr-card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "1rem", marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                <div style={{
                  width: 40, height: 40, borderRadius: 12,
                  background: "var(--accent-glow)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  color: "var(--accent)", fontSize: "1rem"
                }}>
                  <i className="fas fa-clipboard"></i>
                </div>
                <div>
                  <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>Shared Clipboard</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Type or paste, then click Send.</div>
                </div>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", flexShrink: 0 }}>
                <button
                  className="btn btn-primary"
                  style={{ padding: "0.6rem 1.25rem", fontSize: "0.85rem" }}
                  onClick={handleSendClipboard}
                  disabled={!canSend}
                >
                  <i className="fas fa-paper-plane" style={{ fontSize: "0.8rem" }}></i>
                  Send
                </button>
                <button
                  className="btn btn-secondary"
                  style={{ padding: "0.6rem 1.25rem", fontSize: "0.85rem" }}
                  onClick={handleCopyReceived}
                  disabled={!clipboardText}
                >
                  <i className="fas fa-copy" style={{ fontSize: "0.8rem" }}></i>
                  Copy
                </button>
              </div>
            </div>

            <textarea
              className="form-input"
              style={{ minHeight: 180, resize: "none" }}
              placeholder={canSend ? "Type or paste text here, then click Send…" : "Connect first…"}
              value={clipboardText}
              onChange={handleClipboardChange}
            />
          </div>

          {/* Drag & Drop File Card */}
          <div
            className="sr-card"
            style={{ borderStyle: "dashed" }}
            onDrop={onDrop}
            onDragOver={onDragOver}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: "var(--success-glow)",
                display: "flex", alignItems: "center", justifyContent: "center",
                color: "var(--success)", fontSize: "1rem"
              }}>
                <i className="fas fa-file-upload"></i>
              </div>
              <div>
                <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>Drag & Drop File</div>
                <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Sends files peer-to-peer in 256KB chunks.</div>
              </div>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center" }}>
              <label className="btn btn-primary" style={{ cursor: "pointer", padding: "0.75rem 1.5rem", fontSize: "0.9rem" }}>
                <i className="fas fa-folder-open"></i>
                Choose file
                <input type="file" multiple style={{ display: "none" }} onChange={(e) => handleFiles(e.target.files)} />
              </label>
              <div style={{ fontSize: "0.85rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <i className={`fas ${canSend ? "fa-check-circle" : "fa-clock"}`} style={{ color: canSend ? "var(--success)" : "var(--warning)" }}></i>
                {canSend ? "Connected: ready to send." : "Not connected yet."}
              </div>
            </div>

            {sendProgress && (
              <div style={{ marginTop: "1.25rem" }}>
                <ProgressBar
                  value={sendProgress.totalBytes ? sendProgress.sentBytes / sendProgress.totalBytes : 0}
                  label={`Sending ${sendProgress.name} (${formatBytes(sendProgress.sentBytes)} / ${formatBytes(sendProgress.totalBytes)})`}
                />
                <div style={{ marginTop: "0.75rem" }}>
                  <button className="btn btn-secondary" style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }} onClick={cancelActiveSend}>
                    <i className="fas fa-times" style={{ fontSize: "0.75rem" }}></i>
                    Cancel send
                  </button>
                </div>
              </div>
            )}

            {recvProgress && (
              <div style={{ marginTop: "1.25rem" }}>
                <ProgressBar
                  value={recvProgress.totalBytes ? recvProgress.receivedBytes / recvProgress.totalBytes : 0}
                  label={`Receiving ${recvProgress.name} (${formatBytes(recvProgress.receivedBytes)} / ${formatBytes(recvProgress.totalBytes)})`}
                />
                <div style={{ marginTop: "0.75rem" }}>
                  <button className="btn btn-secondary" style={{ padding: "0.5rem 1rem", fontSize: "0.85rem" }} onClick={cancelActiveReceive}>
                    <i className="fas fa-times" style={{ fontSize: "0.75rem" }}></i>
                    Cancel receive
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <TransferHistory items={historyWithActions} />
      </div>
    </div>
  );
}
