import React, { useEffect, useRef, useState } from "react";
import Graph from "./Graph";
import NodeInspector from "./NodeInspector";
import VoiceIndicator from "./VoiceIndicator";
import { useBeliefGraph } from "./useFirestore";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "http://localhost:8080";
const BACKEND_WS = BACKEND_URL.replace("https://", "wss://").replace("http://", "ws://") + "/ws";

export default function App() {
  const { nodes, links, loading } = useBeliefGraph();
  const [selectedNode, setSelectedNode] = useState(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef(null);

  // WebSocket connection to backend
  useEffect(() => {
    function connect() {
      const ws = new WebSocket(BACKEND_WS);

      ws.onopen = () => {
        console.log("[Cortex] WebSocket connected");
        setConnected(true);
      };

      ws.onclose = () => {
        console.log("[Cortex] WebSocket closed, reconnecting...");
        setConnected(false);
        setTimeout(connect, 2000);
      };

      ws.onerror = (err) => {
        console.error("[Cortex] WebSocket error:", err);
      };

      wsRef.current = ws;
    }

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      {/* Header */}
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 48,
          background: "rgba(10, 14, 20, 0.85)",
          backdropFilter: "blur(12px)",
          borderBottom: "1px solid rgba(255,255,255,0.05)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          zIndex: 40,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div
            style={{
              width: 28,
              height: 28,
              background: "linear-gradient(135deg, #4af0b0, #1a73e8)",
              borderRadius: 6,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
              color: "#0a0e14",
            }}
          >
            C
          </div>
          <span
            style={{
              fontSize: 15,
              fontWeight: 600,
              color: "#e6edf3",
              letterSpacing: "0.5px",
            }}
          >
            CORTEX
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          {/* Node count */}
          <span style={{ fontSize: 12, color: "#8b949e" }}>
            {nodes.length} nodes
          </span>

          {/* Connection status */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: connected ? "#3fb950" : "#f85149",
              }}
            />
            <span style={{ fontSize: 11, color: "#8b949e" }}>
              {connected ? "Live" : "Offline"}
            </span>
          </div>

          {/* Legend */}
          <div style={{ display: "flex", gap: 10, marginLeft: 8 }}>
            {[
              { type: "files", color: "#4af0b0" },
              { type: "browser", color: "#4a9ef0" },
              { type: "notes", color: "#f0c14a" },
              { type: "apps", color: "#c04af0" },
            ].map(({ type, color }) => (
              <div
                key={type}
                style={{ display: "flex", alignItems: "center", gap: 4 }}
              >
                <div
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: color,
                  }}
                />
                <span style={{ fontSize: 10, color: "#8b949e" }}>{type}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Loading state */}
      {loading && nodes.length === 0 && (
        <div
          style={{
            position: "fixed",
            top: "50%",
            left: "50%",
            transform: "translate(-50%, -50%)",
            zIndex: 10,
            textAlign: "center",
          }}
        >
          <div
            style={{
              fontSize: 40,
              marginBottom: 16,
              opacity: 0.3,
            }}
          >
            C
          </div>
          <div style={{ fontSize: 14, color: "#8b949e" }}>
            Waiting for beliefs...
          </div>
          <div
            style={{ fontSize: 11, color: "#484f58", marginTop: 8 }}
          >
            Browse the web with the Chrome extension active
          </div>
        </div>
      )}

      {/* D3 Graph */}
      <Graph
        nodes={nodes}
        links={links}
        onNodeClick={setSelectedNode}
      />

      {/* Node Inspector */}
      <NodeInspector
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
      />

      {/* Voice Interface */}
      <VoiceIndicator wsRef={wsRef} />
    </div>
  );
}
