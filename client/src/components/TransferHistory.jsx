import React from "react";

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

function getDirectionIcon(direction) {
  if (direction === "out") return "fa-arrow-up";
  if (direction === "in") return "fa-arrow-down";
  return "fa-info-circle";
}

function getDirectionColor(direction) {
  if (direction === "out") return "var(--accent)";
  if (direction === "in") return "var(--success)";
  return "var(--text-muted)";
}

export default function TransferHistory({ items }) {
  return (
    <div className="sr-card">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12,
            background: "var(--accent-glow)",
            display: "flex", alignItems: "center", justifyContent: "center",
            color: "var(--accent)", fontSize: "1rem"
          }}>
            <i className="fas fa-history"></i>
          </div>
          <div style={{ fontSize: "1.1rem", fontWeight: 700, color: "var(--text-primary)" }}>Transfer History</div>
        </div>
        <span style={{
          background: "var(--bg-tertiary)",
          padding: "0.25rem 0.75rem",
          borderRadius: 50,
          fontSize: "0.8rem",
          fontWeight: 600,
          color: "var(--text-secondary)"
        }}>
          {items.length} item{items.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {items.length === 0 ? (
          <div style={{ textAlign: "center", padding: "2rem 0", color: "var(--text-muted)" }}>
            <i className="fas fa-inbox" style={{ fontSize: "2rem", marginBottom: "0.75rem", display: "block", opacity: 0.3 }}></i>
            <div style={{ fontSize: "0.9rem" }}>Nothing yet.</div>
          </div>
        ) : (
          items.map((it) => (
            <div
              key={it.key}
              style={{
                background: "var(--bg-tertiary)",
                border: "1px solid var(--border)",
                borderRadius: 14,
                padding: "1rem 1.25rem",
                transition: "all 0.3s ease",
                animation: "messageIn 0.3s ease",
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flex: 1, minWidth: 0 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 10, flexShrink: 0,
                    background: it.kind === "system" ? "var(--bg-card)" : `${getDirectionColor(it.direction)}20`,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: getDirectionColor(it.direction),
                    fontSize: "0.9rem"
                  }}>
                    <i className={`fas ${it.kind === "file" ? "fa-file-alt" : it.kind === "clipboard" ? "fa-clipboard" : "fa-info-circle"}`}></i>
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "0.9rem", fontWeight: 600, color: "var(--text-primary)" }}>
                      {it.direction === "out" ? "Sent" : it.direction === "in" ? "Received" : "System"}{" "}
                      {it.kind === "file" ? "file" : it.kind === "clipboard" ? "text" : ""}
                    </div>
                    <div style={{ marginTop: "0.25rem", fontSize: "0.8rem", color: "var(--text-muted)" }}>
                      {it.kind === "file" ? (
                        <>
                          <span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>{it.name}</span>
                          {" · "}{formatBytes(it.size)}
                          {it.status && (
                            <span style={{
                              marginLeft: "0.5rem",
                              padding: "0.15rem 0.5rem",
                              borderRadius: 6,
                              fontSize: "0.7rem",
                              fontWeight: 600,
                              background: it.status === "complete" ? "var(--success-glow)" :
                                          it.status === "active" ? "var(--accent-glow)" :
                                          "var(--danger-glow)",
                              color: it.status === "complete" ? "var(--success)" :
                                     it.status === "active" ? "var(--accent)" :
                                     "var(--danger)"
                            }}>
                              {it.status}
                            </span>
                          )}
                        </>
                      ) : it.kind === "clipboard" ? (
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>{it.preview}</span>
                      ) : (
                        <span>{it.message}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", flexShrink: 0 }}>
                  {it.kind === "file" && it.actions?.cancel && (
                    <button
                      className="btn btn-secondary"
                      style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8 }}
                      onClick={it.actions.cancel}
                    >
                      Cancel
                    </button>
                  )}

                  {it.kind === "file" && it.actions?.save && (
                    <button
                      className="btn"
                      style={{
                        padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8,
                        background: "var(--success)", color: "white", border: "none"
                      }}
                      onClick={it.actions.save}
                    >
                      <i className="fas fa-save" style={{ fontSize: "0.7rem" }}></i>
                      Save
                    </button>
                  )}

                  {it.kind === "file" && it.actions?.retry && (
                    <button
                      className="btn btn-primary"
                      style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8 }}
                      onClick={it.actions.retry}
                    >
                      <i className="fas fa-redo" style={{ fontSize: "0.7rem" }}></i>
                      Retry
                    </button>
                  )}

                  {it.kind === "file" && it.url && (
                    <a
                      className="btn btn-secondary"
                      style={{ padding: "0.4rem 0.75rem", fontSize: "0.8rem", borderRadius: 8, textDecoration: "none" }}
                      href={it.url}
                      download={it.name}
                    >
                      <i className="fas fa-download" style={{ fontSize: "0.7rem" }}></i>
                      Download
                    </a>
                  )}
                </div>
              </div>

              {typeof it.progress === "number" && (
                <div style={{ marginTop: "0.75rem" }}>
                  <div className="sr-progress">
                    <div
                      className="sr-progress-fill"
                      style={{
                        width: `${Math.round(Math.max(0, Math.min(1, it.progress)) * 100)}%`,
                        background: it.direction === "in" ? "var(--gradient-2)" : "var(--gradient-1)"
                      }}
                    />
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
