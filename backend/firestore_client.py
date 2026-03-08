from google.cloud import firestore
from google.cloud.firestore import AsyncClient
import asyncio
import hashlib
import json
from datetime import datetime, timedelta


class FirestoreClient:
    def __init__(self):
        self.db = AsyncClient()
        self.beliefs_col = self.db.collection("beliefs")
        self.edges_col = self.db.collection("edges")
        self.profile_doc = self.db.collection("meta").document("profile")
        self.sessions_col = self.db.collection("sessions")

    def _belief_id(self, statement: str, node_type: str) -> str:
        """Deterministic ID from statement+type — guarantees dedup without queries."""
        raw = f"{node_type}::{statement}".encode()
        return hashlib.sha256(raw).hexdigest()[:20]

    def _edge_id(self, source: str, target: str, relationship: str) -> str:
        raw = f"{source}::{target}::{relationship}".encode()
        return hashlib.sha256(raw).hexdigest()[:20]

    async def add_belief(
        self, statement: str, confidence: float, evidence: list, node_type: str
    ) -> str:
        """Upsert using deterministic doc ID — same statement+type always same doc."""
        doc_id = self._belief_id(statement, node_type)
        ref = self.beliefs_col.document(doc_id)
        doc = await ref.get()
        if doc.exists:
            old_data = doc.to_dict()
            merged_evidence = list(set((old_data.get("evidence") or []) + evidence))[:10]
            new_confidence = min(1.0, max(confidence, old_data.get("confidence", 0)))
            await ref.update({
                "confidence": new_confidence,
                "evidence": merged_evidence,
                "updated_at": firestore.SERVER_TIMESTAMP,
            })
        else:
            await ref.set({
                "statement": statement,
                "confidence": confidence,
                "evidence": evidence,
                "node_type": node_type,
                "created_at": firestore.SERVER_TIMESTAMP,
                "session_id": self._current_session_id(),
            })
        return doc_id

    async def add_edge(self, source: str, target: str, relationship: str):
        """Upsert edge using deterministic doc ID."""
        doc_id = self._edge_id(source, target, relationship)
        ref = self.edges_col.document(doc_id)
        doc = await ref.get()
        if doc.exists:
            return
        await ref.set({
            "source": source,
            "target": target,
            "relationship": relationship,
            "created_at": firestore.SERVER_TIMESTAMP,
        })

    async def get_belief_graph(self) -> dict:
        """Returns nodes and edges for D3 rendering."""
        beliefs_snap = (
            await self.beliefs_col.order_by(
                "confidence", direction=firestore.Query.DESCENDING
            )
            .limit(200)
            .get()
        )

        edges_snap = await self.edges_col.limit(500).get()

        nodes = []
        for d in beliefs_snap:
            data = d.to_dict()
            # Convert Firestore timestamps to ISO strings for JSON serialization
            if data.get("created_at"):
                data["created_at"] = data["created_at"].isoformat()
            nodes.append({"id": d.id, **data})

        links = []
        for d in edges_snap:
            data = d.to_dict()
            if data.get("created_at"):
                data["created_at"] = data["created_at"].isoformat()
            links.append(data)

        return {"nodes": nodes, "links": links}

    async def get_profile(self) -> str:
        doc = await self.profile_doc.get()
        if doc.exists:
            return doc.to_dict().get("content", "No profile yet. User is new.")
        return "No profile yet."

    async def save_profile(self, content: str):
        await self.profile_doc.set(
            {"content": content, "updated_at": firestore.SERVER_TIMESTAMP}
        )

    async def get_graph_digest(self, max_tokens: int = 400) -> str:
        """Returns a short summary of active belief clusters for context injection."""
        beliefs_snap = (
            await self.beliefs_col.order_by(
                "created_at", direction=firestore.Query.DESCENDING
            )
            .limit(20)
            .get()
        )

        recent = [d.to_dict().get("statement", "") for d in beliefs_snap]
        digest = " | ".join(recent[:10])
        return digest[: max_tokens * 4]

    async def get_recent_beliefs(self, limit: int = 50) -> list[dict]:
        snap = (
            await self.beliefs_col.order_by(
                "created_at", direction=firestore.Query.DESCENDING
            )
            .limit(limit)
            .get()
        )
        results = []
        for d in snap:
            data = d.to_dict()
            if data.get("created_at"):
                data["created_at"] = data["created_at"].isoformat()
            results.append({"id": d.id, **data})
        return results

    async def find_session(self, description: str) -> dict:
        """Query Firestore for session matching the description."""
        sessions = (
            await self.sessions_col.order_by(
                "created_at", direction=firestore.Query.DESCENDING
            )
            .limit(20)
            .get()
        )
        # Simple keyword match against session summaries
        desc_lower = description.lower()
        for s in sessions:
            data = s.to_dict()
            summary = data.get("summary", "").lower()
            if any(word in summary for word in desc_lower.split()):
                return data
        return sessions[0].to_dict() if sessions else {}

    async def get_contact(self, name: str) -> list[dict]:
        snap = (
            await self.beliefs_col.where("node_type", "==", "contact")
            .limit(10)
            .get()
        )
        results = []
        for d in snap:
            data = d.to_dict()
            if name.lower() in data.get("statement", "").lower():
                results.append(data)
        return results

    async def get_beliefs_by_ids(self, ids: list) -> list[dict]:
        results = []
        for id_ in ids:
            doc = await self.beliefs_col.document(id_).get()
            if doc.exists:
                data = doc.to_dict()
                if data.get("created_at"):
                    data["created_at"] = data["created_at"].isoformat()
                results.append({"id": doc.id, **data})
        return results

    async def get_cluster(self, cluster_name: str) -> list[dict]:
        return await self.get_recent_beliefs(limit=20)

    async def get_session_beliefs(self) -> list[dict]:
        session_id = self._current_session_id()
        snap = await self.beliefs_col.where("session_id", "==", session_id).get()
        results = []
        for d in snap:
            data = d.to_dict()
            if data.get("created_at"):
                data["created_at"] = data["created_at"].isoformat()
            results.append(data)
        return results

    async def save_session(self, session_data: dict):
        """Save a session snapshot for later restoration."""
        ref = self.sessions_col.document()
        session_data["created_at"] = firestore.SERVER_TIMESTAMP
        session_data["session_id"] = self._current_session_id()
        await ref.set(session_data)

    async def clear_all(self):
        """Delete all beliefs and edges to start fresh."""
        # Delete all beliefs
        beliefs = await self.beliefs_col.limit(500).get()
        for doc in beliefs:
            await doc.reference.delete()
        # Delete all edges
        edges = await self.edges_col.limit(500).get()
        for doc in edges:
            await doc.reference.delete()
        # Clear profile
        await self.profile_doc.delete()

    def _current_session_id(self) -> str:
        return datetime.now().strftime("%Y%m%d_%H")
