import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";

const NODE_COLORS = {
  work: "#4af0b0",
  contact: "#f0c14a",
  project: "#4a9ef0",
  behavior: "#f04a8d",
  intent: "#c04af0",
};

export default function Graph({ nodes, links, onNodeClick }) {
  const svgRef = useRef(null);
  const simulationRef = useRef(null);
  const [dimensions, setDimensions] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const handleResize = () =>
      setDimensions({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const { width, height } = dimensions;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Defs for glow effect
    const defs = svg.append("defs");
    const filter = defs.append("filter").attr("id", "glow");
    filter
      .append("feGaussianBlur")
      .attr("stdDeviation", "3")
      .attr("result", "coloredBlur");
    const feMerge = filter.append("feMerge");
    feMerge.append("feMergeNode").attr("in", "coloredBlur");
    feMerge.append("feMergeNode").attr("in", "SourceGraphic");

    // Build link data — match source/target IDs to node objects
    const nodeMap = new Map(nodes.map((n) => [n.id, n]));
    const validLinks = links
      .filter((l) => nodeMap.has(l.source) && nodeMap.has(l.target))
      .map((l) => ({ ...l, source: l.source, target: l.target }));

    // Container for zoom
    const g = svg.append("g");

    // Zoom behavior
    const zoom = d3
      .zoom()
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => g.attr("transform", event.transform));
    svg.call(zoom);

    // Force simulation
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink(validLinks)
          .id((d) => d.id)
          .distance(80)
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius(30));

    simulationRef.current = simulation;

    // Links
    const link = g
      .append("g")
      .selectAll("line")
      .data(validLinks)
      .join("line")
      .attr("stroke", "rgba(74, 240, 176, 0.15)")
      .attr("stroke-width", 1);

    // Node groups
    const node = g
      .append("g")
      .selectAll("g")
      .data(nodes)
      .join("g")
      .attr("cursor", "pointer")
      .call(
        d3
          .drag()
          .on("start", (event, d) => {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", (event, d) => {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", (event, d) => {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    // Node circles
    node
      .append("circle")
      .attr("r", (d) => 6 + (d.confidence || 0.5) * 12)
      .attr("fill", (d) => NODE_COLORS[d.node_type] || "#4af0b0")
      .attr("opacity", (d) => 0.4 + (d.confidence || 0.5) * 0.6)
      .attr("filter", "url(#glow)");

    // Node labels
    node
      .append("text")
      .text((d) => {
        const stmt = d.statement || "";
        return stmt.length > 30 ? stmt.slice(0, 30) + "..." : stmt;
      })
      .attr("x", 16)
      .attr("y", 4)
      .attr("fill", "#8b949e")
      .attr("font-size", "10px")
      .attr("font-family", "Inter, sans-serif");

    // Click handler
    node.on("click", (event, d) => {
      event.stopPropagation();
      if (onNodeClick) onNodeClick(d);
    });

    // Clear selection on background click
    svg.on("click", () => {
      if (onNodeClick) onNodeClick(null);
    });

    // Tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d) => d.source.x)
        .attr("y1", (d) => d.source.y)
        .attr("x2", (d) => d.target.x)
        .attr("y2", (d) => d.target.y);

      node.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    return () => simulation.stop();
  }, [nodes, links, dimensions, onNodeClick]);

  return (
    <svg
      ref={svgRef}
      width={dimensions.width}
      height={dimensions.height}
      style={{ position: "absolute", top: 0, left: 0, background: "#0a0e14" }}
    />
  );
}
