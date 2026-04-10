import React, { useMemo, useState } from "react";

function formatPin(pin) {
  const s = String(pin || "").replace(/\D/g, "").slice(0, 6);
  return s;
}

export default function HomeScreen({ signaling, onStartSender, onStartReceiver, onError }) {
  const [pinInput, setPinInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState(null); // null | receiver

  const canJoin = useMemo(() => formatPin(pinInput).length === 6, [pinInput]);

  const handleGenerate = async () => {
    try {
      setBusy(true);
      const res = await signaling.createPin();
      if (!res?.ok) throw new Error(res?.reason || "PIN generation failed");
      onStartSender({ pin: res.pin });
    } catch (e) {
      onError(e?.message || "Failed to generate PIN.");
    } finally {
      setBusy(false);
    }
  };

  const handleJoin = async () => {
    try {
      setBusy(true);
      const pin = formatPin(pinInput);
      const res = await signaling.joinPin(pin);
      if (!res?.ok) {
        const reason = res?.reason;
        if (reason === "NOT_FOUND" || reason === "EXPIRED") throw new Error("Invalid PIN.");
        if (reason === "ROOM_FULL") throw new Error("That PIN already has two devices connected.");
        throw new Error("Could not join with that PIN.");
      }
      onStartReceiver({ pin });
    } catch (e) {
      onError(e?.message || "Failed to join PIN.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* Start Card */}
      <div className="sr-card">
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
          <div className="feature-icon" style={{ width: 50, height: 50, borderRadius: 14, fontSize: "1.2rem", marginBottom: 0 }}>
            <i className="fas fa-bolt"></i>
          </div>
          <div>
            <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>Start</div>
            <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
              No login. Connect two devices with a 6-digit PIN via WebRTC.
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gap: "1rem", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginTop: "1.5rem" }}>
          <button
            className="btn btn-primary"
            onClick={handleGenerate}
            disabled={busy}
            style={{ flexDirection: "column", padding: "1.5rem", alignItems: "flex-start" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <i className="fas fa-key"></i>
              <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>Generate PIN</span>
            </div>
            <div style={{ fontSize: "0.85rem", opacity: 0.8, marginTop: "0.25rem" }}>Sender</div>
          </button>

          <button
            className="btn btn-secondary"
            onClick={() => setMode("receiver")}
            disabled={busy}
            style={{ flexDirection: "column", padding: "1.5rem", alignItems: "flex-start" }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <i className="fas fa-sign-in-alt"></i>
              <span style={{ fontSize: "1.1rem", fontWeight: 700 }}>Enter PIN</span>
            </div>
            <div style={{ fontSize: "0.85rem", opacity: 0.8, marginTop: "0.25rem" }}>Receiver</div>
          </button>
        </div>
      </div>

      {/* Enter PIN Card */}
      {mode === "receiver" && (
        <div className="sr-card" style={{ animation: "messageIn 0.3s ease" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", marginBottom: "1rem" }}>
            <div style={{
              width: 50, height: 50, borderRadius: 14,
              background: "var(--gradient-2)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: "1.2rem", color: "white",
              boxShadow: "0 5px 20px var(--success-glow)"
            }}>
              <i className="fas fa-hashtag"></i>
            </div>
            <div>
              <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>Enter the 6-digit PIN</div>
              <div style={{ fontSize: "0.9rem", color: "var(--text-secondary)" }}>
                Ask the sender for their PIN, then connect.
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem", alignItems: "center", marginTop: "1rem" }}>
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              placeholder="123456"
              className="form-input"
              style={{
                flex: 1,
                minWidth: 150,
                fontSize: "1.2rem",
                letterSpacing: "0.3em",
                fontFamily: "'Courier New', monospace",
                textAlign: "center"
              }}
              value={pinInput}
              onChange={(e) => setPinInput(formatPin(e.target.value))}
              disabled={busy}
            />
            <button
              className="btn btn-primary"
              onClick={handleJoin}
              disabled={!canJoin || busy}
              style={{ padding: "1rem 2rem" }}
            >
              <i className="fas fa-link"></i>
              Connect
            </button>
          </div>

          <div style={{ marginTop: "1rem", fontSize: "0.85rem", color: "var(--text-muted)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <i className="fas fa-info-circle" style={{ color: "var(--accent)" }}></i>
            Tip: Keep this tab open. If either device sleeps, WebRTC may disconnect.
          </div>
        </div>
      )}
    </div>
  );
}
