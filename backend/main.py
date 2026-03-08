from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
import os
from dotenv import load_dotenv

load_dotenv()

from session import CortexSession
from beliefs import BeliefEngine
from firestore_client import FirestoreClient

app = FastAPI(title="Cortex Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

db = FirestoreClient()
belief_engine = BeliefEngine(db)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    session = CortexSession(websocket, db, belief_engine)
    try:
        await session.run()
    except WebSocketDisconnect:
        await session.cleanup()


@app.get("/health")
def health():
    return {"status": "ok", "service": "cortex-backend"}


@app.get("/graph")
async def get_graph():
    """Returns the full belief graph for D3 rendering."""
    return await db.get_belief_graph()


@app.get("/profile")
async def get_profile():
    """Returns the current compressed user profile."""
    content = await db.get_profile()
    return {"profile": content}


@app.get("/beliefs")
async def get_beliefs(limit: int = 50):
    """Returns recent beliefs ordered by time."""
    return await db.get_recent_beliefs(limit=limit)


@app.post("/observe")
async def post_observation(observation: dict):
    """HTTP endpoint for observations (fallback when WebSocket is unavailable)."""
    beliefs = await belief_engine.process_observation_batch([observation])
    for belief in beliefs:
        await db.add_belief(
            belief["statement"],
            belief["confidence"],
            belief["evidence"],
            belief["node_type"],
        )
    return {"beliefs_formed": len(beliefs)}


@app.post("/reset")
async def reset_graph():
    """Clear all beliefs and edges to start fresh."""
    await db.clear_all()
    return {"status": "cleared"}
