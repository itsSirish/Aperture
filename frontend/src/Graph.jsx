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
  const r = Math.min(w, h) * 0.35; // bigger spread between clusters
  const angle = (id / CLUSTERS.length) * Math.PI * 2 - Math.PI / 2;
  return { x: w / 2 + r * Math.cos(angle), y: h / 2 + r * Math.sin(angle) };
}

// Hash a string to a stable number for consistent sizing
function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Give each node a unique stable radius based on its id + confidence
function nodeRadius(d) {
  const base = 4 + (hashStr(d.id) % 15); // 4–18 base from hash
  const conf = (d.confidence || 0.5);
  return base * (0.6 + conf * 0.8); // scale by confidence: 60%-140% of base
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
  const stateRef = useRef({ nodes: [], initialized: false, settled: false });

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    const w = window.innerWidth, h = window.innerHeight;

    if (!stateRef.current.initialized) {
      stateRef.current.initialized = true;
      svg.selectAll("*").remove();

      const defs = svg.append("defs");
      const f = defs.append("filter").attr("id", "glow").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
      f.append("feGaussianBlur").attr("stdDeviation", "5").attr("result", "b");
      const m = f.append("feMerge");
      m.append("feMergeNode").attr("in", "b");
      m.append("feMergeNode").attr("in", "SourceGraphic");

      // Softer glow for smaller nodes
      const f2 = defs.append("filter").attr("id", "glow-soft").attr("x", "-50%").attr("y", "-50%").attr("width", "200%").attr("height", "200%");
      f2.append("feGaussianBlur").attr("stdDeviation", "2").attr("result", "b");
      const m2 = f2.append("feMerge");
      m2.append("feMergeNode").attr("in", "b");
      m2.append("feMergeNode").attr("in", "SourceGraphic");

      const g = svg.append("g").attr("class", "root");
      g.append("g").attr("class", "cluster-zones");
      g.append("g").attr("class", "edges");
      g.append("g").attr("class", "nodes");
      g.append("g").attr("class", "cluster-labels");

      svg.call(d3.zoom().scaleExtent([0.25, 3]).on("zoom", e => g.attr("transform", e.transform)));
      svg.on("click", () => onNodeClick && onNodeClick(null));

      CLUSTERS.forEach(c => {
        const pos = clusterCenter(c.id, w, h);

        g.select(".cluster-zones").append("circle")
          .attr("cx", pos.x).attr("cy", pos.y)
          .attr("r", Math.min(w, h) * 0.16)
          .attr("fill", c.color).attr("fill-opacity", 0.015)
          .attr("stroke", c.color).attr("stroke-opacity", 0.04)
          .attr("stroke-width", 1)
          .attr("stroke-dasharray", "4,4");

        g.select(".cluster-labels").append("text")
          .attr("x", pos.x).attr("y", pos.y)
          .attr("text-anchor", "middle").attr("dominant-baseline", "middle")
          .attr("fill", c.color).attr("fill-opacity", 0.1)
          .attr("font-size", "28px").attr("font-weight", "800")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .attr("letter-spacing", "6px")
          .text(c.label.toUpperCase());
      });
    }

    const g = svg.select(".root");

    // Merge — preserve positions
    const oldMap = new Map(stateRef.current.nodes.map(n => [n.id, n]));
    const newIds = new Set(nodes.map(n => n.id));
    const hasNewNodes = nodes.some(n => !oldMap.has(n.id));

    const merged = nodes.map(n => {
      const old = oldMap.get(n.id);
      if (old) return { ...n, x: old.x, y: old.y, vx: 0, vy: 0 };
      const cid = typeToCluster[n.node_type] ?? 0;
      const cc = clusterCenter(cid, w, h);
      return { ...n, x: cc.x + (Math.random() - 0.5) * 80, y: cc.y + (Math.random() - 0.5) * 80 };
    });
    stateRef.current.nodes = merged;

    // If no new nodes and sim already settled, skip simulation restart
    if (!hasNewNodes && stateRef.current.settled) return;

    const auto = buildEdges(merged);
    const nodeIds = new Set(merged.map(n => n.id));
    const be = (links || []).filter(l => nodeIds.has(l.source) && nodeIds.has(l.target)).map(l => ({ ...l, weight: 3 }));
    const allEdges = [...be, ...auto];

    if (simRef.current) simRef.current.stop();

    const sim = d3.forceSimulation(merged)
      .force("link", d3.forceLink(allEdges).id(d => d.id).distance(40).strength(0.03))
      .force("charge", d3.forceManyBody().strength(-40))
      .force("collision", d3.forceCollide(d => nodeRadius(d) + 4))
      .force("cx", d3.forceX(d => clusterCenter(typeToCluster[d.node_type] ?? 0, w, h).x).strength(0.12))
      .force("cy", d3.forceY(d => clusterCenter(typeToCluster[d.node_type] ?? 0, w, h).y).strength(0.12))
      .alpha(hasNewNodes ? 0.15 : 0.05) // barely move if no new nodes
      .alphaDecay(0.08) // settle FAST
      .velocityDecay(0.75); // heavy damping — no jitter

    simRef.current = sim;

    // Mark settled once simulation cools
    sim.on("end", () => { stateRef.current.settled = true; });

    // ── Edges ──
    const eSel = g.select(".edges").selectAll("line").data(allEdges, d => `${d.source?.id||d.source}-${d.target?.id||d.target}`);
    eSel.exit().transition().duration(600).attr("stroke-opacity", 0).remove();
    const eEnter = eSel.enter().append("line")
      .attr("stroke", d => {
        const src = merged.find(n => n.id === (d.source?.id || d.source));
        return NODE_COLORS[src?.node_type] || "#4af0b0";
      })
      .attr("stroke-opacity", 0)
      .attr("stroke-width", d => 0.2 + Math.min(d.weight, 4) * 0.15);
    eEnter.transition().duration(1000).attr("stroke-opacity", d => 0.02 + Math.min(d.weight, 4) * 0.025);
    const allE = eEnter.merge(eSel);

    // ── Nodes ──
    const nSel = g.select(".nodes").selectAll("g.node").data(merged, d => d.id);
    nSel.exit().transition().duration(600).attr("opacity", 0).remove();

    const nEnter = nSel.enter().append("g").attr("class", "node").attr("cursor", "pointer").attr("opacity", 0);
    nEnter.transition().duration(800).delay((_, i) => Math.min(i * 25, 500)).attr("opacity", 1);

    // Outer glow circle
    nEnter.append("circle").attr("class", "glow-ring")
      .attr("r", d => nodeRadius(d) * 1.8)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", d => 0.03 + (d.confidence || 0.5) * 0.04)
      .attr("filter", "url(#glow)");

    // Main blob
    nEnter.append("circle").attr("class", "dot")
      .attr("r", d => nodeRadius(d))
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", d => 0.2 + (d.confidence || 0.5) * 0.4)
      .attr("filter", "url(#glow-soft)");

    // Bright center
    nEnter.append("circle").attr("class", "core")
      .attr("r", d => Math.max(1.5, nodeRadius(d) * 0.25))
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", 0.85);

    const allN = nEnter.merge(nSel);

    // Hover
    allN
      .on("mouseenter", function(_, d) {
        const r = nodeRadius(d);
        d3.select(this).select(".dot").transition().duration(200)
          .attr("opacity", 0.7).attr("r", r * 1.3);
        d3.select(this).select(".glow-ring").transition().duration(200)
          .attr("opacity", 0.12);

        g.select(".tooltip").remove();
        const tip = g.append("g").attr("class", "tooltip")
          .attr("transform", `translate(${d.x},${d.y})`)
          .attr("opacity", 0);
        tip.transition().duration(200).attr("opacity", 1);

        const text = d.statement || "";
        const short = text.length > 55 ? text.slice(0, 55) + "..." : text;
        const type = (d.node_type || "").toUpperCase();
        const conf = Math.round((d.confidence || 0) * 100) + "%";
        const boxW = Math.max(short.length * 5.8, 100);
        const offset = r * 1.4 + 8;

        tip.append("rect")
          .attr("x", offset).attr("y", -20)
          .attr("width", boxW).attr("height", 32)
          .attr("rx", 6)
          .attr("fill", "rgba(8,12,18,0.94)")
          .attr("stroke", NODE_COLORS[d.node_type] || "#4af0b0")
          .attr("stroke-opacity", 0.25).attr("stroke-width", 0.5);

        tip.append("text")
          .attr("x", offset + 8).attr("y", -4)
          .attr("fill", "#dde2ea").attr("font-size", "9.5px")
          .attr("font-family", "Inter, system-ui, sans-serif")
          .text(short);

        tip.append("text")
          .attr("x", offset + 8).attr("y", 9)
          .attr("fill", NODE_COLORS[d.node_type] || "#4af0b0")
          .attr("font-size", "7px").attr("opacity", 0.5)
          .attr("font-family", "Inter, system-ui, sans-serif")
          .text(`${type}  ·  ${conf}`);

        allE.transition().duration(200).attr("stroke-opacity", e => {
          const s = e.source?.id || e.source, t = e.target?.id || e.target;
          return (s === d.id || t === d.id) ? 0.35 : 0.005;
        }).attr("stroke-width", e => {
          const s = e.source?.id || e.source, t = e.target?.id || e.target;
          return (s === d.id || t === d.id) ? 1.2 : 0.2;
        });
      })
      .on("mouseleave", function(_, d) {
        const r = nodeRadius(d);
        d3.select(this).select(".dot").transition().duration(400)
          .attr("opacity", 0.2 + (d.confidence || 0.5) * 0.4).attr("r", r);
        d3.select(this).select(".glow-ring").transition().duration(400)
          .attr("opacity", 0.03 + (d.confidence || 0.5) * 0.04);
        g.select(".tooltip").transition().duration(200).attr("opacity", 0).remove();
        allE.transition().duration(400)
          .attr("stroke-opacity", e => 0.02 + Math.min(e.weight, 4) * 0.025)
          .attr("stroke-width", e => 0.2 + Math.min(e.weight, 4) * 0.15);
      });

    // Drag
    allN.call(d3.drag()
      .on("start", (e, d) => {
        stateRef.current.settled = false;
        if (!e.active) sim.alphaTarget(0.02).restart();
        d.fx = d.x; d.fy = d.y;
      })
      .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
      .on("end", (e, d) => { if (!e.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

    allN.on("click", (e, d) => { e.stopPropagation(); onNodeClick && onNodeClick(d); });

    // Smooth tick with requestAnimationFrame
    sim.on("tick", () => {
      allE.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      allN.attr("transform", d => `translate(${d.x},${d.y})`);
    });

  }, [nodes, links, onNodeClick]);

  useEffect(() => () => { if (simRef.current) simRef.current.stop(); }, []);

  return <svg ref={svgRef} style={{
    position: "absolute", top: 0, left: 0,
    width: "100vw", height: "100vh", background: "#0a0e14",
  }} />;
}
