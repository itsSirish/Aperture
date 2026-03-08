import { initializeApp } from "firebase/app";
import {
  getFirestore,
  collection,
  onSnapshot,
  query,
  orderBy,
  limit,
} from "firebase/firestore";
import { useEffect, useState } from "react";

const firebaseConfig = {
  projectId: process.env.REACT_APP_PROJECT_ID || "cortex-hackathon",
  apiKey: process.env.REACT_APP_FIREBASE_API_KEY || "",
  authDomain: `${process.env.REACT_APP_PROJECT_ID || "cortex-hackathon"}.firebaseapp.com`,
};

let app;
let db;

try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
} catch (e) {
  console.warn("[Cortex] Firebase init failed, using REST fallback:", e.message);
}

export function useBeliefGraph() {
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Try Firestore real-time first
    if (db) {
      try {
        const q = query(
          collection(db, "beliefs"),
          orderBy("confidence", "desc"),
          limit(200)
        );
        const unsub = onSnapshot(
          q,
          (snap) => {
            setNodes(
              snap.docs.map((d) => ({ id: d.id, ...d.data() }))
            );
            setLoading(false);
          },
          (err) => {
            console.warn("[Cortex] Firestore snapshot error, falling back to REST:", err.message);
            fetchFromREST();
          }
        );
        return unsub;
      } catch (e) {
        console.warn("[Cortex] Firestore query failed:", e.message);
      }
    }

    // REST fallback — poll the backend /graph endpoint
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
