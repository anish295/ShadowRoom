import React from "react";

export default function ProgressBar({ value, label }) {
  const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
      {label && (
        <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <i className="fas fa-spinner fa-spin" style={{ fontSize: "0.75rem", color: "var(--accent)" }}></i>
          {label}
        </div>
      )}
      <div className="sr-progress">
        <div className="sr-progress-fill" style={{ width: `${Math.round(v * 100)}%` }} />
      </div>
    </div>
  );
}
