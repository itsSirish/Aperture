import React, { useEffect, useRef } from "react";
import * as d3 from "d3";

const NODE_COLORS = {
  work: "#4af0b0",
  contact: "#f0c14a",
  project: "#4a9ef0",
  behavior: "#f04a8d",
  intent: "#c04af0",
  career: "#f0c14a",
  event: "#4a9ef0",
  interest: "#c04af0",
  resource: "#4af0b0",
  tool: "#f09a4a",
  research: "#c04af0",
  activity: "#4af0b0",
  task: "#f04a8d",
};

const CLUSTERS = {
  0: { label: "WORK & PROJECTS", types: ["project", "work", "activity", "task"] },
  1: { label: "INTENT & RESEARCH", types: ["intent", "interest", "research"] },
  2: { label: "CAREER & CONTACTS", types: ["career", "contact", "event"] },
  3: { label: "TOOLS & RESOURCES", types: ["tool", "resource", "behavior"] },
};

function getCluster(nodeType) {
  for (const [id, cluster] of Object.entries(CLUSTERS)) {
    if (cluster.types.includes(nodeType)) return parseInt(id);
  }
  return 0;
}

function getClusterCenter(clusterId, w, h) {
  const cx = w / 2, cy = h / 2, spread = Math.min(w, h) * 0.28;
  const positions = [
    { x: cx - spread, y: cy - spread },
    { x: cx + spread, y: cy - spread },
    { x: cx - spread, y: cy + spread },
    { x: cx + spread, y: cy + spread },
  ];
  return positions[clusterId] || positions[0];
}

function buildAutoEdges(nodes) {
  const edges = [];
  const stopWords = new Set([
    "user", "is", "the", "a", "an", "and", "or", "for", "to", "in",
    "on", "of", "with", "are", "has", "been", "was", "actively",
    "working", "using", "currently", "likely", "potentially",
  ]);

  const nodeWords = nodes.map(n => {
    const words = (n.statement || "").toLowerCase().split(/\s+/);
    return new Set(words.filter(w => w.length > 3 && !stopWords.has(w)));
  });

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let shared = 0;
      for (const w of nodeWords[i]) {
        if (nodeWords[j].has(w)) shared++;
      }
      if (shared >= 2) {
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: shared });
      }
    }
  }
  return edges;
}

export default function Graph({ nodes, links, onNodeClick }) {
  const svgRef = useRef(null);
  const simRef = useRef(null);
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const gRef = useRef(null);
  const zoomRef = useRef(null);
  const initRef = useRef(false);

  // One-time SVG setup
  useEffect(() => {
    if (!svgRef.current || initRef.current) return;
    initRef.current = true;

    const svg = d3.select(svgRef.current);
    const w = window.innerWidth, h = window.innerHeight;

    // Glow filter
    const defs = svg.append("defs");
    const f = defs.append("filter").attr("id", "glow");
    f.append("feGaussianBlur").attr("stdDeviation", "3").attr("result", "blur");
    const m = f.append("feMerge");
    m.append("feMergeNode").attr("in", "blur");
    m.append("feMergeNode").attr("in", "SourceGraphic");

    const g = svg.append("g");
    gRef.current = g;
    g.append("g").attr("class", "cluster-bgs");
    g.append("g").attr("class", "edges");
    g.append("g").attr("class", "nodes");

    const zoom = d3.zoom().scaleExtent([0.3, 3]).on("zoom", e => g.attr("transform", e.transform));
    zoomRef.current = zoom;
    svg.call(zoom);
    svg.call(zoom.transform, d3.zoomIdentity.translate(0, 0).scale(1));
    svg.on("click", () => onNodeClick && onNodeClick(null));

    // Draw cluster backgrounds
    const clusterBgs = g.select(".cluster-bgs");
    Object.entries(CLUSTERS).forEach(([id, cluster]) => {
      const center = getClusterCenter(parseInt(id), w, h);
      const grp = clusterBgs.append("g");

      // Subtle circle background
      grp.append("circle")
        .attr("cx", center.x).attr("cy", center.y)
        .attr("r", Math.min(w, h) * 0.18)
        .attr("fill", "rgba(255,255,255,0.015)")
        .attr("stroke", "rgba(255,255,255,0.03)")
        .attr("stroke-width", 1);

      // Label
      grp.append("text")
        .attr("x", center.x).attr("y", center.y - Math.min(w, h) * 0.16)
        .attr("text-anchor", "middle")
        .attr("fill", "rgba(200,210,230,0.12)")
        .attr("font-size", "12px")
        .attr("font-weight", "600")
        .attr("letter-spacing", "3px")
        .attr("font-family", "Inter, sans-serif")
        .text(cluster.label);
    });
  }, [onNodeClick]);

  // Update when nodes change — SMOOTH, no restart from scratch
  useEffect(() => {
    if (!gRef.current || nodes.length === 0) return;

    const w = window.innerWidth, h = window.innerHeight;
    const g = gRef.current;

    // Merge new nodes into existing, preserving positions
    const existingMap = new Map(nodesRef.current.map(n => [n.id, n]));
    const mergedNodes = nodes.map(n => {
      const existing = existingMap.get(n.id);
      if (existing) {
        // Update data but keep position
        return { ...n, x: existing.x, y: existing.y, vx: existing.vx, vy: existing.vy };
      }
      // New node — place near its cluster center with jitter
      const cluster = getCluster(n.node_type);
      const center = getClusterCenter(cluster, w, h);
      return {
        ...n,
        x: center.x + (Math.random() - 0.5) * 80,
        y: center.y + (Math.random() - 0.5) * 80,
      };
    });
    nodesRef.current = mergedNodes;

    // Build edges
    const autoEdges = buildAutoEdges(mergedNodes);
    const nodeIds = new Set(mergedNodes.map(n => n.id));
    const backendEdges = (links || [])
      .filter(l => nodeIds.has(l.source) && nodeIds.has(l.target))
      .map(l => ({ source: l.source, target: l.target, weight: 3 }));
    const allEdges = [...backendEdges, ...autoEdges];
    edgesRef.current = allEdges;

    // ── Simulation ──
    if (simRef.current) simRef.current.stop();

    const sim = d3.forceSimulation(mergedNodes)
      .force("link", d3.forceLink(allEdges).id(d => d.id).distance(60).strength(0.1))
      .force("charge", d3.forceManyBody().strength(-100))
      .force("collision", d3.forceCollide(25))
      .force("cx", d3.forceX(d => getClusterCenter(getCluster(d.node_type), w, h).x).strength(0.08))
      .force("cy", d3.forceY(d => getClusterCenter(getCluster(d.node_type), w, h).y).strength(0.08))
      .alphaDecay(0.05)
      .velocityDecay(0.5)
      .alpha(0.3); // Gentle start — not explosive

    simRef.current = sim;

    // ── EDGES ──
    const edgeSel = g.select(".edges").selectAll("line").data(allEdges, d => {
      const s = d.source?.id || d.source;
      const t = d.target?.id || d.target;
      return `${s}--${t}`;
    });

    edgeSel.exit().transition().duration(500).attr("stroke-opacity", 0).remove();

    const edgeEnter = edgeSel.enter().append("line")
      .attr("stroke-opacity", 0)
      .attr("stroke", "#4af0b0")
      .attr("stroke-width", d => 0.3 + Math.min(d.weight, 4) * 0.3);

    edgeEnter.transition().duration(800).attr("stroke-opacity", d => 0.04 + Math.min(d.weight, 4) * 0.04);

    const allEdgeSel = edgeEnter.merge(edgeSel);

    // ── NODES ──
    const nodeSel = g.select(".nodes").selectAll("g.node").data(mergedNodes, d => d.id);

    nodeSel.exit().transition().duration(500)
      .attr("opacity", 0)
      .attr("transform", d => `translate(${d.x},${d.y}) scale(0.3)`)
      .remove();

    const nodeEnter = nodeSel.enter().append("g")
      .attr("class", "node")
      .attr("cursor", "pointer")
      .attr("opacity", 0);

    // Animate new nodes in
    nodeEnter.transition().duration(800).delay((d, i) => i * 30).attr("opacity", 1);

    // Outer ring
    nodeEnter.append("circle")
      .attr("r", d => 10 + (d.confidence || 0.5) * 10)
      .attr("fill", "none")
      .attr("stroke", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("stroke-width", 0.5)
      .attr("stroke-opacity", 0.2);

    // Inner dot
    nodeEnter.append("circle")
      .attr("class", "dot")
      .attr("r", d => 4 + (d.confidence || 0.5) * 8)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", d => 0.3 + (d.confidence || 0.5) * 0.5)
      .attr("filter", "url(#glow)");

    // Statement label
    nodeEnter.append("text")
      .text(d => {
        const s = d.statement || "";
        return s.length > 38 ? s.slice(0, 38) + "..." : s;
      })
      .attr("dx", d => 14 + (d.confidence || 0.5) * 8)
      .attr("dy", 0)
      .attr("dominant-baseline", "middle")
      .attr("fill", "#9ca3b0")
      .attr("font-size", "9.5px")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("pointer-events", "none");

    // Type tag
    nodeEnter.append("text")
      .text(d => (d.node_type || "").toUpperCase())
      .attr("dx", d => 14 + (d.confidence || 0.5) * 8)
      .attr("dy", 13)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("font-size", "7.5px")
      .attr("font-family", "Inter, system-ui, sans-serif")
      .attr("opacity", 0.4)
      .attr("pointer-events", "none");

    const allNodeSel = nodeEnter.merge(nodeSel);

    // Hover
    allNodeSel
      .on("mouseenter", function(_, d) {
        d3.select(this).select(".dot").transition().duration(150).attr("opacity", 1);
        d3.select(this).selectAll("text").transition().duration(150).attr("fill", "#fff");
        allEdgeSel.transition().duration(150).attr("stroke-opacity", e => {
          const s = e.source?.id || e.source;
          const t = e.target?.id || e.target;
          return (s === d.id || t === d.id) ? 0.5 : 0.02;
        });
      })
      .on("mouseleave", function(_, d) {
        d3.select(this).select(".dot").transition().duration(300)
          .attr("opacity", 0.3 + (d.confidence || 0.5) * 0.5);
        d3.select(this).selectAll("text").transition().duration(300)
          .attr("fill", "#9ca3b0");
        allEdgeSel.transition().duration(300)
          .attr("stroke-opacity", e => 0.04 + Math.min(e.weight, 4) * 0.04);
      });

    // Drag
    allNodeSel.call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.05).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

    // Click
    allNodeSel.on("click", (e, d) => { e.stopPropagation(); onNodeClick && onNodeClick(d); });

    // Tick — smooth position updates
    sim.on("tick", () => {
      allEdgeSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      allNodeSel.attr("transform", d => `translate(${d.x},${d.y})`);
    });

  }, [nodes, links, onNodeClick]);

  // Cleanup
  useEffect(() => () => { if (simRef.current) simRef.current.stop(); }, []);

  return (
    <svg ref={svgRef} style={{
      position: "absolute", top: 0, left: 0,
      width: "100vw", height: "100vh",
      background: "#0a0e14",
    }} />
  );
}
