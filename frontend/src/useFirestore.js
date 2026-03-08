import { useEffect, useState } from "react";

export function useBeliefGraph() {
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFromREST();
    const interval = setInterval(fetchFromREST, 5000);
    return () => clearInterval(interval);
  }, []);

  async function fetchFromREST() {
    const backendUrl =
      process.env.REACT_APP_BACKEND_URL || "http://localhost:8080";
    try {
      const resp = await fetch(`${backendUrl}/graph`);
      const data = await resp.json();
      setNodes(data.nodes || []);
      setLinks(data.links || []);
      setLoading(false);
    } catch (e) {
      console.warn("[Cortex] REST fetch failed:", e.message);
      setLoading(false);
    }
  }

  return { nodes, links, loading };
}
