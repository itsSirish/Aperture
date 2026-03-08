import React, { useEffect, useRef, useCallback } from "react";
import * as d3 from "d3";

const NODE_COLORS = {
  file: "#4af0b0", folder: "#3dd69e", tab: "#4a9ef0", domain: "#1a73e8",
  topic: "#6aa3f0", note: "#f0c14a", music: "#f04a8d", app: "#c04af0",
  intent: "#c04af0", project: "#4a9ef0", career: "#f0c14a", tool: "#f09a4a",
  research: "#c04af0", work: "#4af0b0", contact: "#f0c14a", event: "#4a9ef0",
  interest: "#c04af0", resource: "#4af0b0", activity: "#4af0b0",
  task: "#f04a8d", behavior: "#f04a8d",
};

const CLUSTERS = [
  { id: 0, label: "Files", types: ["file", "folder"], color: "#4af0b0" },
  { id: 1, label: "Browser", types: ["tab", "domain", "topic"], color: "#4a9ef0" },
  { id: 2, label: "Notes & Music", types: ["note", "music"], color: "#f0c14a" },
  { id: 3, label: "Apps & Insights", types: ["app", "intent", "project", "career", "tool", "research", "work", "contact", "event", "interest", "resource", "activity", "task", "behavior"], color: "#c04af0" },
];

const typeToCluster = {};
CLUSTERS.forEach(c => c.types.forEach(t => { typeToCluster[t] = c.id; }));

function clusterCenter(id, w, h) {
  const r = Math.min(w, h) * 0.32;
  const angle = (id / CLUSTERS.length) * Math.PI * 2 - Math.PI / 2;
  return { x: w / 2 + r * Math.cos(angle), y: h / 2 + r * Math.sin(angle) };
}

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function nodeRadius(d) {
  // Topic/folder nodes are bigger (they're sub-cluster centers)
  const isParent = d.node_type === "topic" || d.node_type === "folder" || d.node_type === "domain";
  const base = isParent ? 12 + (hashId(d.id) % 8) : 3 + (hashId(d.id) % 10);
  return base * (0.5 + (d.confidence || 0.5) * 1.0);
}

function deduplicateNodes(rawNodes) {
  // Keep only one node per statement+node_type, highest confidence wins
  const seen = new Map();
  for (const n of rawNodes) {
    const key = `${n.node_type}::${n.statement}`;
    const existing = seen.get(key);
    if (!existing || (n.confidence || 0) > (existing.confidence || 0)) {
      seen.set(key, n);
    }
  }
  return Array.from(seen.values());
}

function buildEdges(nodes, firestoreLinks) {
  const edges = [];
  const idToIdx = new Map();
  nodes.forEach((n, i) => idToIdx.set(n.id, i));

  // 1. Use real edges from Firestore
  for (const link of firestoreLinks) {
    const si = idToIdx.get(link.source);
    const ti = idToIdx.get(link.target);
    if (si !== undefined && ti !== undefined) {
      edges.push({ source: si, target: ti, weight: 2 });
    }
  }

  // 2. Connect nodes within same cluster that share keywords
  const stop = new Set(["user","is","the","a","an","and","or","for","to","in","on","of","with","are","has","been","was","actively","working","using","currently","likely","potentially","related"]);
  const nw = nodes.map(n => {
    const w = (n.statement||"").toLowerCase().split(/\s+/).filter(x => x.length > 3 && !stop.has(x));
    return new Set(w);
  });
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let s = 0;
      for (const w of nw[i]) if (nw[j].has(w)) s++;
      if (s >= 2 && (typeToCluster[nodes[i].node_type] === typeToCluster[nodes[j].node_type])) {
        edges.push({ source: i, target: j, weight: s });
      }
    }
  }
  return edges;
}

export default function Graph({ nodes, links, onNodeClick }) {
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  const stateRef = useRef({ nodes: [], edges: [], hovered: null, settled: false });
  const tooltipRef = useRef(null);
  const frameRef = useRef(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const state = stateRef.current;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(dpr, dpr);

    const sw = w / dpr, sh = h / dpr;

    // Draw cluster zones
    CLUSTERS.forEach(c => {
      const pos = clusterCenter(c.id, sw, sh);
      const r = Math.min(sw, sh) * 0.18;

      // Zone circle
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.color + "06";
      ctx.fill();
      ctx.strokeStyle = c.color + "12";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Label
      ctx.fillStyle = c.color + "18";
      ctx.font = "800 24px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.label.toUpperCase(), pos.x, pos.y);
    });

    // Draw edges
    for (const e of state.edges) {
      const s = state.nodes[e.source];
      const t = state.nodes[e.target];
      if (!s || !t) continue;
      const isHovered = state.hovered && (state.hovered.id === s.id || state.hovered.id === t.id);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = isHovered
        ? (NODE_COLORS[s.node_type] || "#4af0b0") + "50"
        : (NODE_COLORS[s.node_type] || "#4af0b0") + "08";
      ctx.lineWidth = isHovered ? 1.2 : 0.3;
      ctx.stroke();
    }

    // Draw nodes
    for (const d of state.nodes) {
      const r = nodeRadius(d);
      const color = NODE_COLORS[d.node_type] || "#4af0b0";
      const isHovered = state.hovered && state.hovered.id === d.id;

      // Outer glow
      ctx.beginPath();
      ctx.arc(d.x, d.y, r * 2, 0, Math.PI * 2);
      ctx.fillStyle = color + (isHovered ? "20" : "08");
      ctx.fill();

      // Main circle
      ctx.beginPath();
      ctx.arc(d.x, d.y, isHovered ? r * 1.3 : r, 0, Math.PI * 2);
      const alpha = isHovered ? "bb" : Math.round((0.25 + (d.confidence || 0.5) * 0.5) * 255).toString(16).padStart(2, "0");
      ctx.fillStyle = color + alpha;
      ctx.fill();

      // Bright core
      ctx.beginPath();
      ctx.arc(d.x, d.y, Math.max(1, r * 0.3), 0, Math.PI * 2);
      ctx.fillStyle = color + "dd";
      ctx.fill();
    }

    // Tooltip for hovered node
    if (state.hovered) {
      const d = state.hovered;
      const r = nodeRadius(d);
      const color = NODE_COLORS[d.node_type] || "#4af0b0";
      const text = d.statement || "";
      const short = text.length > 55 ? text.slice(0, 55) + "..." : text;
      const type = (d.node_type || "").toUpperCase();
      const conf = Math.round((d.confidence || 0) * 100) + "%";
      const label = `${short}  ·  ${type}  ·  ${conf}`;

      ctx.font = "10px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(label).width + 16;
      const tx = d.x + r * 1.5 + 6;
      const ty = d.y - 12;

      // Background
      ctx.fillStyle = "rgba(8,12,18,0.92)";
      ctx.beginPath();
      const rr = 4;
      ctx.moveTo(tx + rr, ty);
      ctx.lineTo(tx + tw - rr, ty);
      ctx.arcTo(tx + tw, ty, tx + tw, ty + rr, rr);
      ctx.lineTo(tx + tw, ty + 22 - rr);
      ctx.arcTo(tx + tw, ty + 22, tx + tw - rr, ty + 22, rr);
      ctx.lineTo(tx + rr, ty + 22);
      ctx.arcTo(tx, ty + 22, tx, ty + 22 - rr, rr);
      ctx.lineTo(tx, ty + rr);
      ctx.arcTo(tx, ty, tx + rr, ty, rr);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = color + "40";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Text
      ctx.fillStyle = "#dde2ea";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx + 8, ty + 11);
    }

    ctx.restore();
    frameRef.current = requestAnimationFrame(draw);
  }, []);

  // Setup canvas + simulation
  useEffect(() => {
    if (!canvasRef.current || nodes.length === 0) return;

    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    // Deduplicate nodes client-side
    const dedupedNodes = deduplicateNodes(nodes);

    // Merge nodes — preserve positions
    const oldMap = new Map(stateRef.current.nodes.map(n => [n.id, n]));
    const hasNew = dedupedNodes.some(n => !oldMap.has(n.id));

    const merged = dedupedNodes.map(n => {
      const old = oldMap.get(n.id);
      if (old) return { ...n, x: old.x, y: old.y, vx: 0, vy: 0 };
      const cid = typeToCluster[n.node_type] ?? 3;
      const cc = clusterCenter(cid, w, h);
      return { ...n, x: cc.x + (Math.random() - 0.5) * 80, y: cc.y + (Math.random() - 0.5) * 80 };
    });

    if (!hasNew && stateRef.current.settled) {
      stateRef.current.nodes = merged;
      // Keep render loop alive even when settled
      if (!frameRef.current) {
        frameRef.current = requestAnimationFrame(draw);
      }
      return;
    }

    const edges = buildEdges(merged, links);
    stateRef.current.nodes = merged;
    stateRef.current.edges = edges;
    stateRef.current.settled = false;

    if (simRef.current) simRef.current.stop();

    const sim = d3.forceSimulation(merged)
      .force("link", d3.forceLink(edges).distance(30).strength(0.02))
      .force("charge", d3.forceManyBody().strength(-25))
      .force("collision", d3.forceCollide(d => nodeRadius(d) + 2))
      .force("cx", d3.forceX(d => clusterCenter(typeToCluster[d.node_type] ?? 3, w, h).x).strength(0.1))
      .force("cy", d3.forceY(d => clusterCenter(typeToCluster[d.node_type] ?? 3, w, h).y).strength(0.1))
      .alpha(hasNew ? 0.12 : 0.03)
      .alphaDecay(0.1)
      .velocityDecay(0.8);

    sim.on("end", () => { stateRef.current.settled = true; });
    simRef.current = sim;

    // Start render loop (only if not already running)
    if (!frameRef.current) {
      frameRef.current = requestAnimationFrame(draw);
    }
  }, [nodes, links, draw]);

  // Mouse interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const getNode = (ex, ey) => {
      for (let i = stateRef.current.nodes.length - 1; i >= 0; i--) {
        const d = stateRef.current.nodes[i];
        const dx = d.x - ex, dy = d.y - ey;
        if (dx * dx + dy * dy < (nodeRadius(d) + 4) ** 2) return d;
      }
      return null;
    };

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const node = getNode(x, y);
      stateRef.current.hovered = node;
      canvas.style.cursor = node ? "pointer" : "default";
    };

    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left, y = e.clientY - rect.top;
      const node = getNode(x, y);
      if (onNodeClick) onNodeClick(node);
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
  }, [onNodeClick]);

  // Cleanup
  useEffect(() => () => {
    if (simRef.current) simRef.current.stop();
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
  }, []);

  return (
    <>
      <canvas ref={canvasRef} style={{
        position: "absolute", top: 0, left: 0,
        width: "100vw", height: "100vh", background: "#0a0e14",
      }} />
      <div ref={tooltipRef} />
    </>
  );
}
