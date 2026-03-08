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
  const isParent = d.node_type === "topic" || d.node_type === "folder" || d.node_type === "domain";
  const base = isParent ? 14 + (hashId(d.id) % 6) : 3 + (hashId(d.id) % 8);
  return base * (0.5 + (d.confidence || 0.5) * 1.0);
}

function deduplicateNodes(rawNodes) {
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

  // 1. Real edges from Firestore (part_of, inside, etc.)
  for (const link of firestoreLinks) {
    const si = idToIdx.get(link.source);
    const ti = idToIdx.get(link.target);
    if (si !== undefined && ti !== undefined) {
      edges.push({ source: si, target: ti, weight: 2, real: true });
    }
  }

  // 2. Keyword-overlap edges within same cluster
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
        edges.push({ source: i, target: j, weight: s, real: false });
      }
    }
  }
  return edges;
}

export default function Graph({ nodes, links, onNodeClick }) {
  const canvasRef = useRef(null);
  const simRef = useRef(null);
  const stateRef = useRef({ nodes: [], edges: [], hovered: null, settled: false });
  const frameRef = useRef(null);
  // Zoom/pan transform
  const transformRef = useRef({ x: 0, y: 0, k: 1 });

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height;
    const dpr = window.devicePixelRatio || 1;
    const state = stateRef.current;
    const t = transformRef.current;

    ctx.clearRect(0, 0, w, h);
    ctx.save();
    ctx.scale(dpr, dpr);

    const sw = w / dpr, sh = h / dpr;

    // Apply zoom/pan transform
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);

    // Draw cluster zones (fixed in world space)
    CLUSTERS.forEach(c => {
      const pos = clusterCenter(c.id, sw, sh);
      const r = Math.min(sw, sh) * 0.18;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.color + "06";
      ctx.fill();
      ctx.strokeStyle = c.color + "12";
      ctx.lineWidth = 1 / t.k;
      ctx.setLineDash([4 / t.k, 4 / t.k]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = c.color + "18";
      ctx.font = `800 ${24 / t.k}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(c.label.toUpperCase(), pos.x, pos.y);
    });

    // Draw edges
    for (const e of state.edges) {
      const s = state.nodes[e.source];
      const tt = state.nodes[e.target];
      if (!s || !tt) continue;
      const isHovered = state.hovered && (state.hovered.id === s.id || state.hovered.id === tt.id);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(tt.x, tt.y);
      if (e.real) {
        // Real Firestore edges — always visible
        ctx.strokeStyle = isHovered
          ? (NODE_COLORS[s.node_type] || "#4af0b0") + "90"
          : (NODE_COLORS[s.node_type] || "#4af0b0") + "30";
        ctx.lineWidth = isHovered ? 2 / t.k : 1 / t.k;
      } else {
        // Keyword edges — subtle
        ctx.strokeStyle = isHovered
          ? (NODE_COLORS[s.node_type] || "#4af0b0") + "50"
          : (NODE_COLORS[s.node_type] || "#4af0b0") + "0a";
        ctx.lineWidth = isHovered ? 1.2 / t.k : 0.3 / t.k;
      }
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

      // Show label on zoom or for parent nodes
      const isParent = d.node_type === "topic" || d.node_type === "folder" || d.node_type === "domain";
      if (isHovered || (t.k > 1.5 && isParent) || t.k > 2.5) {
        const fontSize = Math.max(8, Math.min(11, 10 / t.k));
        ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.fillStyle = "#dde2ea";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const label = (d.statement || "").length > 25 ? d.statement.slice(0, 25) + "…" : d.statement;
        ctx.fillText(label, d.x, d.y + r + 3);
      }
    }

    ctx.restore(); // end zoom transform

    // Tooltip for hovered node (drawn in screen space, not world space)
    if (state.hovered) {
      const d = state.hovered;
      const r = nodeRadius(d);
      const color = NODE_COLORS[d.node_type] || "#4af0b0";
      const text = d.statement || "";
      const short = text.length > 55 ? text.slice(0, 55) + "..." : text;
      const type = (d.node_type || "").toUpperCase();
      const conf = Math.round((d.confidence || 0) * 100) + "%";
      const label = `${short}  ·  ${type}  ·  ${conf}`;

      // Convert world coords to screen coords
      const sx = d.x * t.k + t.x;
      const sy = d.y * t.k + t.y;

      ctx.font = "11px Inter, system-ui, sans-serif";
      const tw = ctx.measureText(label).width + 20;
      const tx = sx + r * t.k + 10;
      const ty = sy - 14;

      ctx.fillStyle = "rgba(8,12,18,0.94)";
      ctx.beginPath();
      const rr = 5;
      ctx.moveTo(tx + rr, ty);
      ctx.lineTo(tx + tw - rr, ty);
      ctx.arcTo(tx + tw, ty, tx + tw, ty + rr, rr);
      ctx.lineTo(tx + tw, ty + 26 - rr);
      ctx.arcTo(tx + tw, ty + 26, tx + tw - rr, ty + 26, rr);
      ctx.lineTo(tx + rr, ty + 26);
      ctx.arcTo(tx, ty + 26, tx, ty + 26 - rr, rr);
      ctx.lineTo(tx, ty + rr);
      ctx.arcTo(tx, ty, tx + rr, ty, rr);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = color + "50";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      ctx.fillStyle = "#e6edf3";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, tx + 10, ty + 13);
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
      .force("link", d3.forceLink(edges).distance(d => d.real ? 50 : 30).strength(d => d.real ? 0.15 : 0.02))
      .force("charge", d3.forceManyBody().strength(-25))
      .force("collision", d3.forceCollide(d => nodeRadius(d) + 2))
      .force("cx", d3.forceX(d => clusterCenter(typeToCluster[d.node_type] ?? 3, w, h).x).strength(0.1))
      .force("cy", d3.forceY(d => clusterCenter(typeToCluster[d.node_type] ?? 3, w, h).y).strength(0.1))
      .alpha(hasNew ? 0.12 : 0.03)
      .alphaDecay(0.1)
      .velocityDecay(0.8);

    sim.on("end", () => { stateRef.current.settled = true; });
    simRef.current = sim;

    if (!frameRef.current) {
      frameRef.current = requestAnimationFrame(draw);
    }
  }, [nodes, links, draw]);

  // Zoom/pan + mouse interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    // Screen coords → world coords
    const toWorld = (sx, sy) => {
      const t = transformRef.current;
      return { x: (sx - t.x) / t.k, y: (sy - t.y) / t.k };
    };

    const getNode = (sx, sy) => {
      const { x, y } = toWorld(sx, sy);
      for (let i = stateRef.current.nodes.length - 1; i >= 0; i--) {
        const d = stateRef.current.nodes[i];
        const dx = d.x - x, dy = d.y - y;
        if (dx * dx + dy * dy < (nodeRadius(d) + 6) ** 2) return d;
      }
      return null;
    };

    const onMove = (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const node = getNode(sx, sy);
      stateRef.current.hovered = node;
      canvas.style.cursor = node ? "pointer" : (isPanning ? "grabbing" : "grab");
    };

    const onClick = (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const node = getNode(sx, sy);
      if (onNodeClick) onNodeClick(node);
    };

    // Zoom with scroll wheel
    const onWheel = (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const t = transformRef.current;

      const scaleFactor = e.deltaY < 0 ? 1.1 : 0.9;
      const newK = Math.max(0.3, Math.min(8, t.k * scaleFactor));

      // Zoom towards mouse position
      const wx = (mx - t.x) / t.k;
      const wy = (my - t.y) / t.k;
      transformRef.current = {
        k: newK,
        x: mx - wx * newK,
        y: my - wy * newK,
      };
    };

    // Pan with mouse drag
    let isPanning = false;
    let panStart = { x: 0, y: 0 };
    let transformStart = { x: 0, y: 0 };

    const onMouseDown = (e) => {
      // Only pan if not clicking a node
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
      const node = getNode(sx, sy);
      if (node) return; // let onClick handle it
      isPanning = true;
      panStart = { x: e.clientX, y: e.clientY };
      transformStart = { x: transformRef.current.x, y: transformRef.current.y };
      canvas.style.cursor = "grabbing";
    };

    const onMouseMovePan = (e) => {
      if (!isPanning) return;
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      transformRef.current.x = transformStart.x + dx;
      transformRef.current.y = transformStart.y + dy;
    };

    const onMouseUp = () => {
      isPanning = false;
      canvas.style.cursor = "grab";
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("mousemove", onMouseMovePan);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("mousemove", onMouseMovePan);
      canvas.removeEventListener("click", onClick);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mouseup", onMouseUp);
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
        cursor: "grab",
      }} />
      {/* Zoom hint */}
      <div style={{
        position: "fixed", bottom: 16, left: 16, zIndex: 10,
        fontSize: 10, color: "#484f58",
      }}>
        Scroll to zoom · Drag to pan
      </div>
    </>
  );
}
