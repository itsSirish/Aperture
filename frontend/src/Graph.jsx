import React, { useEffect, useRef, useCallback } from "react";
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

// Group similar node types into clusters
const CLUSTER_MAP = {
  project: 0,
  work: 0,
  activity: 0,
  task: 0,
  intent: 1,
  interest: 1,
  research: 1,
  career: 2,
  contact: 2,
  event: 2,
  tool: 3,
  resource: 3,
  behavior: 3,
};

const CLUSTER_CENTERS = [
  { x: -250, y: -150 }, // work/project cluster (top-left)
  { x: 250, y: -150 },  // intent/research cluster (top-right)
  { x: -250, y: 200 },  // career/contact cluster (bottom-left)
  { x: 250, y: 200 },   // tool/resource cluster (bottom-right)
];

const CLUSTER_LABELS = ["Work & Projects", "Intent & Research", "Career & Contacts", "Tools & Resources"];

export default function Graph({ nodes, links, onNodeClick }) {
  const svgRef = useRef(null);
  const simulationRef = useRef(null);
  const gRef = useRef(null);
  const initializedRef = useRef(false);
  const prevNodeCountRef = useRef(0);

  // Initialize SVG once
  useEffect(() => {
    if (!svgRef.current || initializedRef.current) return;
    initializedRef.current = true;

    const svg = d3.select(svgRef.current);

    // Defs for glow
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "glow");
    filter.append("feGaussianBlur").attr("stdDeviation", "4").attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Softer glow for links
    const filter2 = defs.append("filter").attr("id", "linkGlow");
    filter2.append("feGaussianBlur").attr("stdDeviation", "2").attr("result", "coloredBlur");
    const feMerge2 = filter2.append("feMerge");
    feMerge2.append("feMergeNode").attr("in", "coloredBlur");
    feMerge2.append("feMergeNode").attr("in", "SourceGraphic");

    const g = svg.append("g");
    gRef.current = g;

    // Layer ordering: cluster labels → links → nodes
    g.append("g").attr("class", "cluster-labels");
    g.append("g").attr("class", "links");
    g.append("g").attr("class", "nodes");

    // Zoom
    const zoom = d3.zoom().scaleExtent([0.2, 3]).on("zoom", (event) => {
      g.attr("transform", event.transform);
    });
    svg.call(zoom);

    // Initial zoom to center
    const w = window.innerWidth;
    const h = window.innerHeight;
    svg.call(zoom.transform, d3.zoomIdentity.translate(w / 2, h / 2).scale(0.9));

    svg.on("click", () => { if (onNodeClick) onNodeClick(null); });
  }, [onNodeClick]);

  const updateGraph = useCallback(() => {
    if (!gRef.current || nodes.length === 0) return;

    // Skip if no change
    if (nodes.length === prevNodeCountRef.current && simulationRef.current) return;
    prevNodeCountRef.current = nodes.length;

    const g = gRef.current;

    // Auto-generate edges between nodes in the same cluster that share keywords
    const autoLinks = [];
    const seenPairs = new Set();

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const clusterA = CLUSTER_MAP[a.node_type] ?? 0;
        const clusterB = CLUSTER_MAP[b.node_type] ?? 0;

        // Connect nodes in same cluster
        const sameCluster = clusterA === clusterB;

        // Connect nodes that share significant words
        const wordsA = (a.statement || "").toLowerCase().split(/\s+/);
        const wordsB = (b.statement || "").toLowerCase().split(/\s+/);
        const stopWords = new Set(["is", "the", "a", "an", "and", "or", "for", "to", "in", "on", "of", "with", "user", "is", "are", "has", "been", "was"]);
        const sigWordsA = wordsA.filter(w => w.length > 3 && !stopWords.has(w));
        const sigWordsB = new Set(wordsB.filter(w => w.length > 3 && !stopWords.has(w)));
        const shared = sigWordsA.filter(w => sigWordsB.has(w));

        const pairKey = `${a.id}-${b.id}`;
        if (seenPairs.has(pairKey)) continue;

        if (shared.length >= 2 || (sameCluster && shared.length >= 1)) {
          seenPairs.add(pairKey);
          autoLinks.push({
            source: a.id,
            target: b.id,
            strength: Math.min(shared.length / 3, 1),
            shared: shared.slice(0, 3),
          });
        }
      }
    }

    // Only use links where source/target are valid node IDs
    const nodeIds = new Set(nodes.map(n => n.id));
    const backendLinks = (links || [])
      .filter(l => nodeIds.has(l.source) && nodeIds.has(l.target))
      .map(l => ({ source: l.source, target: l.target, strength: 0.8 }));
    const allLinks = [...backendLinks, ...autoLinks];

    // Assign cluster positions
    nodes.forEach((n) => {
      const cluster = CLUSTER_MAP[n.node_type] ?? 0;
      const center = CLUSTER_CENTERS[cluster];
      if (n.x === undefined) {
        n.x = center.x + (Math.random() - 0.5) * 150;
        n.y = center.y + (Math.random() - 0.5) * 150;
      }
    });

    if (simulationRef.current) simulationRef.current.stop();

    const simulation = d3
      .forceSimulation(nodes)
      .force("link", d3.forceLink(allLinks).id(d => d.id).distance(80).strength(d => (d.strength || 0.5) * 0.3))
      .force("charge", d3.forceManyBody().strength(-180))
      .force("collision", d3.forceCollide().radius(35))
      // Pull nodes toward their cluster center
      .force("clusterX", d3.forceX(d => CLUSTER_CENTERS[CLUSTER_MAP[d.node_type] ?? 0].x).strength(0.15))
      .force("clusterY", d3.forceY(d => CLUSTER_CENTERS[CLUSTER_MAP[d.node_type] ?? 0].y).strength(0.15))
      .alphaDecay(0.03)
      .velocityDecay(0.4);

    simulationRef.current = simulation;

    // ── Cluster labels ──
    const labelSel = g.select(".cluster-labels").selectAll("text").data(CLUSTER_LABELS);
    labelSel.enter().append("text")
      .merge(labelSel)
      .attr("x", (d, i) => CLUSTER_CENTERS[i].x)
      .attr("y", (d, i) => CLUSTER_CENTERS[i].y - 120)
      .attr("text-anchor", "middle")
      .attr("fill", "rgba(200,208,224,0.15)")
      .attr("font-size", "14px")
      .attr("font-weight", "600")
      .attr("font-family", "'Inter', sans-serif")
      .attr("letter-spacing", "2px")
      .text(d => d.toUpperCase());

    // ── Links ──
    const linkSel = g.select(".links").selectAll("line").data(allLinks, d => `${d.source?.id || d.source}-${d.target?.id || d.target}`);
    linkSel.exit().transition().duration(300).attr("opacity", 0).remove();

    const linkEnter = linkSel.enter().append("line")
      .attr("stroke", d => {
        // Color links by the cluster of their source node
        const sourceNode = nodes.find(n => n.id === (d.source?.id || d.source));
        const color = NODE_COLORS[sourceNode?.node_type] || "#4af0b0";
        return color;
      })
      .attr("stroke-opacity", d => 0.08 + (d.strength || 0.3) * 0.15)
      .attr("stroke-width", d => 0.5 + (d.strength || 0.3) * 1.5)
      .attr("filter", "url(#linkGlow)");

    const allLinkSel = linkEnter.merge(linkSel);

    // ── Nodes ──
    const nodeSel = g.select(".nodes").selectAll("g.node").data(nodes, d => d.id);
    nodeSel.exit().transition().duration(300).attr("opacity", 0).remove();

    const nodeEnter = nodeSel.enter().append("g").attr("class", "node").attr("cursor", "pointer").attr("opacity", 0);

    // Animate in
    nodeEnter.transition().duration(500).attr("opacity", 1);

    // Outer ring
    nodeEnter.append("circle")
      .attr("class", "ring")
      .attr("r", d => 12 + (d.confidence || 0.5) * 12)
      .attr("fill", "none")
      .attr("stroke", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("stroke-width", 0.5)
      .attr("stroke-opacity", 0.3);

    // Main circle
    nodeEnter.append("circle")
      .attr("class", "main")
      .attr("r", d => 6 + (d.confidence || 0.5) * 10)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", d => 0.4 + (d.confidence || 0.5) * 0.6)
      .attr("filter", "url(#glow)");

    // Label
    nodeEnter.append("text")
      .attr("class", "label")
      .text(d => {
        const stmt = d.statement || "";
        return stmt.length > 40 ? stmt.slice(0, 40) + "..." : stmt;
      })
      .attr("x", d => 14 + (d.confidence || 0.5) * 10)
      .attr("y", 0)
      .attr("dominant-baseline", "middle")
      .attr("fill", "#c8d0e0")
      .attr("font-size", "10px")
      .attr("font-family", "'Inter', sans-serif")
      .attr("pointer-events", "none");

    // Type tag
    nodeEnter.append("text")
      .attr("class", "tag")
      .text(d => (d.node_type || "").toUpperCase())
      .attr("x", d => 14 + (d.confidence || 0.5) * 10)
      .attr("y", 14)
      .attr("fill", d => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("font-size", "8px")
      .attr("font-family", "'Inter', sans-serif")
      .attr("opacity", 0.5)
      .attr("pointer-events", "none");

    const allNodes = nodeEnter.merge(nodeSel);

    // Hover effects
    allNodes
      .on("mouseenter", function (event, d) {
        d3.select(this).select(".main").transition().duration(200).attr("opacity", 1);
        d3.select(this).select(".ring").transition().duration(200).attr("stroke-opacity", 0.8);
        d3.select(this).select(".label").transition().duration(200).attr("fill", "#ffffff");
        // Highlight connected links
        allLinkSel
          .transition().duration(200)
          .attr("stroke-opacity", l => {
            const sid = l.source?.id || l.source;
            const tid = l.target?.id || l.target;
            return (sid === d.id || tid === d.id) ? 0.6 : 0.05;
          })
          .attr("stroke-width", l => {
            const sid = l.source?.id || l.source;
            const tid = l.target?.id || l.target;
            return (sid === d.id || tid === d.id) ? 2 : 0.5;
          });
      })
      .on("mouseleave", function () {
        d3.select(this).select(".main").transition().duration(200).attr("opacity", d => 0.4 + (d.confidence || 0.5) * 0.6);
        d3.select(this).select(".ring").transition().duration(200).attr("stroke-opacity", 0.3);
        d3.select(this).select(".label").transition().duration(200).attr("fill", "#c8d0e0");
        allLinkSel
          .transition().duration(200)
          .attr("stroke-opacity", d => 0.08 + (d.strength || 0.3) * 0.15)
          .attr("stroke-width", d => 0.5 + (d.strength || 0.3) * 1.5);
      });

    // Drag
    allNodes.call(
      d3.drag()
        .on("start", (event, d) => {
          if (!event.active) simulation.alphaTarget(0.1).restart();
          d.fx = d.x; d.fy = d.y;
        })
        .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end", (event, d) => {
          if (!event.active) simulation.alphaTarget(0);
          d.fx = null; d.fy = null;
        })
    );

    // Click
    allNodes.on("click", (event, d) => {
      event.stopPropagation();
      if (onNodeClick) onNodeClick(d);
    });

    // Tick
    simulation.on("tick", () => {
      allLinkSel
        .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
        .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
      allNodes.attr("transform", d => `translate(${d.x},${d.y})`);
    });
  }, [nodes, links, onNodeClick]);

  useEffect(() => { updateGraph(); }, [updateGraph]);

  useEffect(() => {
    return () => { if (simulationRef.current) simulationRef.current.stop(); };
  }, []);

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute", top: 0, left: 0,
        width: "100vw", height: "100vh",
        background: "#0a0e14",
      }}
    />
  );
}
