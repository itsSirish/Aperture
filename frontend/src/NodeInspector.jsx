import React from "react";

const NODE_COLORS = {
  work: "#4af0b0",
  contact: "#f0c14a",
  project: "#4a9ef0",
  behavior: "#f04a8d",
  intent: "#c04af0",
};

export default function NodeInspector({ node, onClose }) {
  if (!node) return null;

  const color = NODE_COLORS[node.node_type] || "#4af0b0";

  return (
    <div
      style={{
        position: "fixed",
        top: 24,
        right: 24,
        width: 340,
        background: "rgba(13, 17, 23, 0.95)",
        border: `1px solid ${color}33`,
        borderRadius: 12,
        padding: 20,
        zIndex: 30,
        backdropFilter: "blur(12px)",
        boxShadow: `0 0 40px ${color}15`,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 16,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <div
            style={{
              width: 10,
              height: 10,
              borderRadius: "50%",
              background: color,
              boxShadow: `0 0 8px ${color}`,
            }}
          />
          <span
            style={{
              fontSize: 11,
              textTransform: "uppercase",
              letterSpacing: "1px",
              color: color,
              fontWeight: 600,
            }}
          >
            {node.node_type}
          </span>
        </div>
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: "#8b949e",
            cursor: "pointer",
            fontSize: 18,
            lineHeight: 1,
          }}
        >
          x
        </button>
      </div>

      {/* Statement */}
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.5,
          color: "#e6edf3",
          marginBottom: 16,
        }}
      >
        {node.statement}
      </div>

      {/* Confidence bar */}
      <div style={{ marginBottom: 16 }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 4,
          }}
        >
          <span style={{ fontSize: 11, color: "#8b949e" }}>Confidence</span>
          <span style={{ fontSize: 11, color: color }}>
            {Math.round((node.confidence || 0) * 100)}%
          </span>
        </div>
        <div
          style={{
            width: "100%",
            height: 4,
            background: "#21262d",
            borderRadius: 2,
          }}
        >
          <div
            style={{
              width: `${(node.confidence || 0) * 100}%`,
              height: "100%",
              background: color,
              borderRadius: 2,
              transition: "width 0.3s ease",
            }}
          />
        </div>
      </div>

      {/* Evidence */}
      {node.evidence && node.evidence.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 11,
              color: "#8b949e",
              marginBottom: 6,
              textTransform: "uppercase",
              letterSpacing: "0.5px",
            }}
          >
            Evidence
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {node.evidence.map((e, i) => (
              <span
                key={i}
                style={{
                  fontSize: 10,
                  padding: "3px 8px",
                  background: `${color}15`,
                  border: `1px solid ${color}30`,
                  borderRadius: 4,
                  color: color,
                }}
              >
                {e}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Metadata */}
      <div style={{ fontSize: 10, color: "#484f58" }}>
        ID: {node.id}
        {node.created_at && (
          <span style={{ marginLeft: 12 }}>
            {new Date(node.created_at).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}
