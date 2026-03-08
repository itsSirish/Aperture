import React, { useEffect, useRef } from "react";
import * as d3 from "d3";

const NODE_COLORS = {
  work: "#4af0b0", contact: "#f0c14a", project: "#4a9ef0", behavior: "#f04a8d",
  intent: "#c04af0", career: "#f0c14a", event: "#4a9ef0", interest: "#c04af0",
  resource: "#4af0b0", tool: "#f09a4a", research: "#c04af0", activity: "#4af0b0",
  task: "#f04a8d",
};

const CLUSTERS = [
  { id: 0, label: "Work", types: ["project", "work", "activity", "task"], color: "#4a9ef0" },
  { id: 1, label: "Intent", types: ["intent", "interest", "research"], color: "#c04af0" },
  { id: 2, label: "Career", types: ["career", "contact", "event"], color: "#f0c14a" },
  { id: 3, label: "Tools", types: ["tool", "resource", "behavior"], color: "#f09a4a" },
];

const typeToCluster = {};
CLUSTERS.forEach(c => c.types.forEach(t => { typeToCluster[t] = c.id; }));

function clusterCenter(id, w, h) {
  const r = Math.min(w, h) * 0.25;
  const angle = (id / CLUSTERS.length) * Math.PI * 2 - Math.PI / 2;
  return { x: w / 2 + r * Math.cos(angle), y: h / 2 + r * Math.sin(angle) };
}

function buildEdges(nodes) {
  const edges = [];
  const stop = new Set(["user","is","the","a","an","and","or","for","to","in","on","of","with","are","has","been","was","actively","working","using","currently","likely","potentially","related"]);
  const nw = nodes.map(n => {
    const w = (n.statement||"").toLowerCase().split(/\s+/).filter(x => x.length > 3 && !stop.has(x));
    return new Set(w);
  });
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      let s = 0;
      for (const w of nw[i]) if (nw[j].has(w)) s++;
      if (s >= 2) edges.push({ source: nodes[i].id, target: nodes[j].id, weight: s });
    }
  }
  return edges;
}

export default function Graph({ nodes, links, onNodeClick }) {
  const svgRef = useRef(null);
  const simRef = useRef(null);
  const stateRef = useRef({ nodes: [], initialized: false });

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    const w = window.innerWidth, h = window.innerHeight;

    // First time setup
    if (!stateRef.current.initialized) {
      stateRef.current.initialized = true;
      svg.selectAll("*").remove();

      const defs = svg.append("defs");
      const f = defs.append("filter").attr("id", "glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
      f.append("feGaussianBlur").attr("stdDeviation", "4").attr("result", "b");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in", "b");
      m.append("feMergeNode").attr("in", "SourceGraphic");

      const g = svg.append("g").attr("class", "root");
      g.append("g").attr("class", "cluster-zones");
      g.append("g").attr("class", "edges");
      g.append("g").attr("class", "nodes");
      g.append("g").attr("class", "cluster-labels");

      // Zoom
      svg.call(d3.zoom().scaleExtent([0.3, 3]).on("zoom", e => g.attr("transform", e.transform)));
      svg.on("click", () => onNodeClick && onNodeClick(null));

      // Cluster center nodes (big label circles)
      CLUSTERS.forEach(c => {
        const pos = clusterCenter(c.id, w, h);

        // Subtle zone
        g.select(".cluster-zones").append("circle")
          .attr("cx", pos.x).attr("cy", pos.y)
          .attr("r", Math.min(w, h) * 0.15)
          .attr("fill", c.color).attr("fill-opacity", 0.02)
          .attr("stroke", c.color).attr("stroke-opacity", 0.06)
          .attr("stroke-width", 1);

        // Cluster label
        g.select(".cluster-labels").append("text")
          .attr("x", pos.x).attr("y", pos.y)
          .attr("text-anchor", "middle").attr("dominant-baseline", "middle")
          .attr("fill", c.color).attr("fill-opacity", 0.15)
          .attr("font-size", "22px").attr("font-weight", "700")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .attr("letter-spacing", "4px")
          .text(c.label.toUpperCase());
      });
    }

    const g = svg.select(".root");

    // Merge nodes — keep existing positions
    const oldMap = new Map(stateRef.current.nodes.map(n => [n.id, n]));
    const merged = nodes.map(n => {
      const old = oldMap.get(n.id);
      if (old) return { ...n, x: old.x, y: old.y, vx: 0, vy: 0 };
      const cid = typeToCluster[n.node_type] ?? 0;
      const cc = clusterCenter(cid, w, h);
      return { ...n, x: cc.x + (Math.random() - 0.5) * 60, y: cc.y + (Math.random() - 0.5) * 60 };
    });
    stateRef.current.nodes = merged;

    // Edges
    const auto = buildEdges(merged);
    const nodeIds = new Set(merged.map(n => n.id));
    const be = (links || []).filter(l => nodeIds.has(l.source) && nodeIds.has(l.target)).map(l => ({ ...l, weight: 3 }));
    const allEdges = [...be, ...auto];

    // Stop old sim
    if (simRef.current) simRef.current.stop();

    // Simulation — very gentle
    const sim = d3.forceSimulation(merged)
      .force("link", d3.forceLink(allEdges).id(d => d.id).distance(50).strength(0.05))
      .force("charge", d3.forceManyBody().strength(-60))
      .force("collision", d3.forceCollide(d => 8 + (d.confidence || 0.5) * 14))
      .force("cx", d3.forceX(d => clusterCenter(typeToCluster[d.node_type] ?? 0, w, h).x).strength(0.06))
      .force("cy", d3.forceY(d => clusterCenter(typeToCluster[d.node_type] ?? 0, w, h).y).strength(0.06))
      .alpha(0.15).alphaDecay(0.04).velocityDecay(0.6);
    simRef.current = sim;

    // ── Edges ──
    const eSel = g.select(".edges").selectAll("line").data(allEdges, d => `${d.source?.id||d.source}-${d.target?.id||d.target}`);
    eSel.exit().transition().duration(400).attr("stroke-opacity", 0).remove();
    const eEnter = eSel.enter().append("line")
      .attr("stroke", "#4af0b0").attr("stroke-opacity", 0).attr("stroke-width", d => 0.3 + Math.min(d.weight, 4) * 0.2);
    eEnter.transition().duration(600).attr("stroke-opacity", d => 0.03 + Math.min(d.weight, 4) * 0.03);
    const allE = eEnter.merge(eSel);

    // ── Nodes ──
    const nSel = g.select(".nodes").selectAll("g.node").data(merged, d => d.id);
    nSel.exit().transition().duration(400).attr("opacity", 0).remove();

    const nEnter = nSel.enter().append("g").attr("class", "node").attr("cursor", "pointer").attr("opacity", 0);
    nEnter.transition().duration(600).delay((_, i) => i * 20).attr("opacity", 1);

    // Circle — size varies by confidence
    nEnter.append("circle").attr("class", "dot")
      .attr("r", d => 5 + (d.confidence || 0.5) * 18)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", d => 0.15 + (d.confidence || 0.5) * 0.45)
      .attr("filter", "url(#glow)");

    // Tiny inner bright dot
    nEnter.append("circle")
      .attr("r", d => 2 + (d.confidence || 0.5) * 4)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", 0.9);

    const allN = nEnter.merge(nSel);

    // Hover — show label on hover only
    allN
      .on("mouseenter", function(_, d) {
        d3.select(this).select(".dot").transition().duration(150)
          .attr("opacity", 0.7).attr("r", 8 + (d.confidence || 0.5) * 20);

        // Show tooltip
        const existing = g.select(".tooltip");
        if (!existing.empty()) existing.remove();

        const tip = g.append("g").attr("class", "tooltip").attr("transform", `translate(${d.x},${d.y})`);

        // Background rect
        const text = d.statement || "";
        const short = text.length > 50 ? text.slice(0, 50) + "..." : text;
        const type = (d.node_type || "").toUpperCase();
        const conf = Math.round((d.confidence || 0) * 100) + "%";

        tip.append("rect")
          .attr("x", 20).attr("y", -24)
          .attr("width", Math.max(short.length * 5.5, 120)).attr("height", 38)
          .attr("rx", 4)
          .attr("fill", "rgba(10,14,20,0.92)")
          .attr("stroke", NODE_COLORS[d.node_type] || "#4af0b0")
          .attr("stroke-opacity", 0.3)
          .attr("stroke-width", 0.5);

        tip.append("text")
          .attr("x", 26).attr("y", -8)
          .attr("fill", "#e0e4ea").attr("font-size", "10px")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .text(short);

        tip.append("text")
          .attr("x", 26).attr("y", 6)
          .attr("fill", NODE_COLORS[d.node_type] || "#4af0b0")
          .attr("font-size", "8px").attr("opacity", 0.6)
          .attr("font-family", "Inter, system-ui, sans-serif")
          .text(`${type}  ·  ${conf}`);

        // Highlight edges
        allE.transition().duration(150).attr("stroke-opacity", e => {
          const s = e.source?.id || e.source, t = e.target?.id || e.target;
          return (s === d.id || t === d.id) ? 0.4 : 0.01;
        }).attr("stroke-width", e => {
          const s = e.source?.id || e.source, t = e.target?.id || e.target;
          return (s === d.id || t === d.id) ? 1.5 : 0.3;
        });
      })
      .on("mouseleave", function(_, d) {
        d3.select(this).select(".dot").transition().duration(300)
          .attr("opacity", 0.15 + (d.confidence || 0.5) * 0.45)
          .attr("r", 5 + (d.confidence || 0.5) * 18);
        g.select(".tooltip").remove();
        allE.transition().duration(300)
          .attr("stroke-opacity", e => 0.03 + Math.min(e.weight, 4) * 0.03)
          .attr("stroke-width", e => 0.3 + Math.min(e.weight, 4) * 0.2);
      });

    // Drag
    allN.call(d3.drag()
      .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.03).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

    // Click
    allN.on("click", (e, d) => { e.stopPropagation(); onNodeClick && onNodeClick(d); });

    // Tick
    sim.on("tick", () => {
      allE.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      allN.attr("transform", d => `translate(${d.x},${d.y})`);
      // Update tooltip position if visible
      const tip = g.select(".tooltip");
      if (!tip.empty()) {
        const tipData = tip.datum();
        if (tipData) tip.attr("transform", `translate(${tipData.x},${tipData.y})`);
      }
    });

  }, [nodes, links, onNodeClick]);

  useEffect(() => () => { if (simRef.current) simRef.current.stop(); }, []);

  return <svg ref={svgRef} style={{
    position: "absolute", top: 0, left: 0,
    width: "100vw", height: "100vh", background: "#0a0e14",
  }} />;
}
