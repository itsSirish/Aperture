# CORTEX — Claude Code Project Prompt
> Your work, made visible. Your context, never lost.
> UI Navigator Track · AIFF × Google Cloud Hackathon · NYC 2026

---

## WHAT YOU ARE BUILDING

Cortex is a persistent ambient AI agent that:
1. Silently watches your work across browser tabs, files, music, and notes
2. Builds a live D3 force-directed knowledge graph of everything meaningful you do
3. Lets you talk to it via Gemini Live (audio-only, always-on, barge-in supported)
4. Restores any past working session instantly on voice command
5. Performs actions (draft email, open search, manage tabs) enriched by full graph context

This is NOT a RAG system. NOT a chatbot. NOT a screen recorder.
It is a belief-formation engine that stores interpreted intelligence, not raw observations.

---

## GOOGLE CLOUD CONTEXT (ALREADY SET UP)

The team has already:
- Provisioned Google Cloud credits via goo.gle/nyc-hackathon
- Cloned the hackathon repo: `github.com/google-americas/2026-nyc-hackathon`
- Run `./init.sh` which has configured the GCP project, enabled APIs, and set up Cloud Shell

Your GCP project is already active. All commands should use that project context.

To verify and set your project in any new terminal:
```bash
gcloud config list project
# If not set:
gcloud config set project $(gcloud projects list --format="value(projectId)" | head -1)
export PROJECT_ID=$(gcloud config get-value project)
export REGION="us-central1"
```

To get your Gemini API key from the provisioned project:
```bash
# Check if already set from init.sh
echo $GOOGLE_API_KEY
# Or generate one from AI Studio (already linked to the project):
# https://aistudio.google.com/app/apikey
```

---

## SCAFFOLD — START HERE, NOT FROM SCRATCH

Clone and use the Way Back Home Level 3 codelab as the base. It gives you:
FastAPI + ADK + Gemini Live + bidirectional WebSocket + concurrent audio streaming — all pre-wired.

```bash
# In Cloud Shell or local terminal
git clone https://codelabs.developers.google.com/way-back-home-level-3
# OR if that's already in the hackathon repo:
cd ~/2026-nyc-hackathon
ls  # find the level-3 scaffold directory
```

Strip the game logic from the scaffold. Replace with Cortex agent loop (see below).
This saves 6-8 hours. Do NOT start from scratch on WebSocket + ADK + Gemini Live wiring.

---

## TARGET PROJECT STRUCTURE

```
cortex/
├── CLAUDE.md                    ← this file
├── README.md                    ← spin-up instructions for judges
├── docker-compose.yml           ← local dev
├── terraform/                   ← IaC bonus points
│   └── main.tf
│
├── backend/                     ← FastAPI on Cloud Run
│   ├── main.py                  ← FastAPI app, WebSocket endpoint
│   ├── agent.py                 ← ADK agent definition + all 8 tools
│   ├── beliefs.py               ← Belief formation logic (Gemini Flash calls)
│   ├── compression.py           ← Profile compression (2000-token fixed window)
│   ├── session.py               ← Gemini Live session management + reconnect
│   ├── firestore_client.py      ← Firestore read/write helpers
│   ├── requirements.txt
│   └── Dockerfile
│
├── extension/                   ← Chrome Extension MV3
│   ├── manifest.json
│   ├── background.js            ← tab events → backend WebSocket
│   ├── content.js               ← DOM observation (on demand only)
│   └── popup.html               ← minimal status UI
│
└── frontend/                    ← React + D3 UI
    ├── package.json
    ├── src/
    │   ├── App.jsx
    │   ├── Graph.jsx            ← D3 force-directed belief graph
    │   ├── VoiceIndicator.jsx   ← Gemini Live status + audio visualizer
    │   ├── NodeInspector.jsx    ← click node → show belief details
    │   └── useFirestore.js      ← real-time Firestore subscription
    └── public/
```

---

## BACKEND — BUILD THIS FIRST

### 1. requirements.txt
```
google-genai>=0.8.0
google-cloud-aiplatform>=1.40.0
google-cloud-firestore>=2.14.0
google-adk>=0.1.0
fastapi>=0.110.0
uvicorn[standard]>=0.27.0
websockets>=12.0
python-dotenv>=1.0.0
httpx>=0.26.0
```

### 2. main.py — FastAPI + WebSocket Entry Point
```python
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio, json, os
from session import CortexSession
from beliefs import BeliefEngine
from firestore_client import FirestoreClient

app = FastAPI(title="Cortex Backend")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

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
def health(): return {"status": "ok"}

@app.get("/graph")
async def get_graph():
    return await db.get_belief_graph()
```

### 3. agent.py — ADK Agent with All 8 Tools
```python
from google.adk.agents import Agent
from google.adk.tools import FunctionTool
from firestore_client import FirestoreClient
import json

db = FirestoreClient()

# ── KNOWLEDGE TOOLS ────────────────────────────────────────────────────

def add_belief(statement: str, confidence: float, evidence: list, node_type: str) -> dict:
    """
    Forms a new belief node in the graph from an interpreted observation.
    node_type: 'work' | 'contact' | 'project' | 'behavior' | 'intent'
    confidence: 0.0 - 1.0
    evidence: list of source strings e.g. ['tab_pattern', 'voice_note', 'file_edit']
    """
    node_id = db.add_belief_sync(statement, confidence, evidence, node_type)
    return {"status": "belief_formed", "node_id": node_id, "statement": statement}

def add_edge(belief_a_id: str, belief_b_id: str, relationship: str) -> dict:
    """
    Connects two belief nodes. 
    relationship: 'related_to' | 'caused_by' | 'blocks' | 'part_of' | 'mentions'
    """
    db.add_edge_sync(belief_a_id, belief_b_id, relationship)
    return {"status": "edge_added", "relationship": relationship}

def query_graph(question: str) -> dict:
    """
    Reasons over the belief graph to answer a natural language question about the user's work.
    Returns a spoken answer grounded in actual beliefs.
    """
    beliefs = db.get_recent_beliefs_sync(limit=50)
    # Return beliefs as context — Gemini Live will synthesize the spoken answer
    return {"beliefs": beliefs, "question": question}

def restore_session(datetime_or_description: str) -> dict:
    """
    Reconstructs a past working context. Reopens browser tabs, surfaces files,
    returns a spoken summary of what the user was doing at that time.
    datetime_or_description: e.g. 'Tuesday afternoon', '2 hours ago', 'when I was working on Kafka'
    """
    session_data = db.find_session_sync(datetime_or_description)
    return {
        "tabs_to_open": session_data.get("tabs", []),
        "files_surfaced": session_data.get("files", []),
        "session_summary": session_data.get("summary", ""),
        "graph_cluster": session_data.get("cluster_id")
    }

def generate_doc(cluster_name: str, output_format: str) -> dict:
    """
    Synthesizes a graph cluster into a document.
    output_format: 'markdown' | 'pdf'
    """
    cluster = db.get_cluster_sync(cluster_name)
    return {"status": "generating", "cluster": cluster, "format": output_format}

# ── ACTION TOOLS ───────────────────────────────────────────────────────

def draft_message(recipient_name: str, context_belief_ids: list) -> dict:
    """
    Drafts an email/message enriched with full graph context about the recipient
    and current work. Returns draft text for user review.
    """
    recipient = db.get_contact_sync(recipient_name)
    beliefs = db.get_beliefs_by_ids_sync(context_belief_ids)
    return {
        "recipient": recipient,
        "context_beliefs": beliefs,
        "instruction": "draft email using recipient contact info and belief context"
    }

def open_search(intent: str) -> dict:
    """
    Generates an intelligent search query from graph context, not generic keywords.
    Intent is what the user wants to find — Cortex adds what it already knows.
    """
    recent_beliefs = db.get_recent_beliefs_sync(limit=10)
    return {"intent": intent, "graph_context": recent_beliefs, "action": "open_browser_search"}

def manage_tabs(action: str, filter_criteria: str) -> dict:
    """
    Controls browser tabs via Chrome Extension.
    action: 'open' | 'close' | 'group' | 'save_session'
    filter_criteria: description of which tabs e.g. 'all research tabs', 'Kafka-related'
    """
    return {"action": action, "filter": filter_criteria, "target": "chrome_extension"}

# ── ADK AGENT DEFINITION ───────────────────────────────────────────────

def build_cortex_agent(compressed_profile: str, graph_digest: str) -> Agent:
    return Agent(
        name="cortex",
        model="gemini-2.0-flash-live-001",
        tools=[
            FunctionTool(add_belief),
            FunctionTool(add_edge),
            FunctionTool(query_graph),
            FunctionTool(restore_session),
            FunctionTool(generate_doc),
            FunctionTool(draft_message),
            FunctionTool(open_search),
            FunctionTool(manage_tabs),
        ],
        system_prompt=f"""
You are Cortex — a persistent ambient intelligence agent.

YOUR CORE BEHAVIOR:
- You observe. You form beliefs. You speak rarely and act intelligently.
- When you speak unprompted, it must feel like you read the user's mind.
- If you speak too often, you have failed. Quality over frequency.
- You NEVER say "I don't have access to that" — you query the graph.

CURRENT USER CONTEXT (compressed profile — always current):
{compressed_profile}

ACTIVE GRAPH DIGEST (current belief clusters):
{graph_digest}

WHAT YOU KNOW HOW TO DO:
- Answer "what have I been working on?" with specific, accurate graph-grounded answers
- Restore any past working session by time or description
- Draft messages that sound like the user wrote them (you know their style and recipients)
- Search intelligently using graph context, not generic queries
- Form beliefs from new observations and connect them to existing knowledge
- Manage browser tabs based on semantic understanding of the user's work

WHAT YOU NEVER DO:
- You are not a chatbot. Do not greet or be conversational unprompted.
- Do not retrieve chunks. Do not stuff context. The profile IS the context.
- Do not explain what you are doing. Just do it.
"""
    )
```

### 4. beliefs.py — Belief Formation Engine
```python
from google import genai
from google.genai import types
import json, os
from firestore_client import FirestoreClient

class BeliefEngine:
    def __init__(self, db: FirestoreClient):
        self.db = db
        self.client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
    
    async def process_observation_batch(self, observations: list[dict]) -> list[dict]:
        """
        Converts raw observations into belief nodes using Gemini Flash.
        Called every 60 seconds with the batch of tab/file/music events.
        """
        existing_profile = await self.db.get_profile()
        
        prompt = f"""
You are forming beliefs from behavioral observations. NOT storing raw data — forming INTERPRETED beliefs.

EXISTING USER PROFILE (2000 tokens, always current):
{existing_profile}

RAW OBSERVATIONS (last 60 seconds):
{json.dumps(observations, indent=2)}

BELIEF FORMATION RULES:
- A tab opened for <30 seconds = ignore
- Same domain visited 3+ times = form a concept belief node  
- File opened across multiple sessions = important file node
- Person mentioned or emailed = contact node
- Recurring time pattern = behavior node
- Something user explicitly asked about = intent node

OUTPUT: JSON array of beliefs to form. Each belief:
{{
  "statement": "User is preparing for Amazon SDE interview — Kafka knowledge needed",
  "confidence": 0.89,
  "evidence": ["tab_pattern", "file_edit", "voice_mention"],
  "node_type": "intent",
  "connect_to": ["existing_node_id_if_related"]
}}

Return ONLY the JSON array. No explanation. No markdown.
Maximum 5 beliefs per batch. Quality over quantity.
"""
        response = await self.client.aio.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt
        )
        
        raw = response.text.strip()
        if raw.startswith("```"):
            raw = raw.split("```")[1].replace("json", "").strip()
        
        return json.loads(raw)
    
    async def compress_profile(self, session_beliefs: list[dict]) -> str:
        """
        After each session, rewrite the 2000-token profile to absorb new beliefs.
        This is the core of why context never rots.
        """
        current_profile = await self.db.get_profile()
        
        prompt = f"""
You are rewriting a compressed user intelligence profile. 
INPUT: existing profile + new session beliefs
OUTPUT: updated profile, EXACTLY 2000 tokens, absorbing new information intelligently

EXISTING PROFILE:
{current_profile}

NEW SESSION BELIEFS:
{json.dumps(session_beliefs, indent=2)}

RULES:
- Output is EXACTLY 2000 tokens — not more, not less
- Merge related beliefs intelligently — don't just append
- Increase confidence on confirmed patterns, decrease on contradicted ones  
- Preserve high-confidence historical beliefs
- Update behavioral patterns with new evidence
- The output is the complete, current truth about this user's work and style

Output the profile text only. No headers. No JSON.
"""
        response = await self.client.aio.models.generate_content(
            model="gemini-2.0-flash",
            contents=prompt,
            config=types.GenerateContentConfig(max_output_tokens=2100)
        )
        
        new_profile = response.text.strip()
        await self.db.save_profile(new_profile)
        return new_profile
```

### 5. session.py — Gemini Live Audio Session
```python
from google import genai
from google.genai import types
import asyncio, os, base64
from agent import build_cortex_agent
from firestore_client import FirestoreClient

class CortexSession:
    def __init__(self, websocket, db: FirestoreClient, belief_engine):
        self.ws = websocket
        self.db = db
        self.belief_engine = belief_engine
        self.client = genai.Client(api_key=os.environ["GOOGLE_API_KEY"])
        self.live_session = None
        self.running = False
        self.observation_buffer = []
    
    async def run(self):
        self.running = True
        
        # Load current profile and graph digest
        profile = await self.db.get_profile()
        graph_digest = await self.db.get_graph_digest(max_tokens=400)
        
        # Audio-only config — gives full 15-min window (not 2-min video limit)
        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=self._build_system_prompt(profile, graph_digest),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
                )
            ),
            # Enable barge-in (user can interrupt agent mid-speech)
            input_audio_config=types.AudioConfig(
                audio_encoding="LINEAR16",
                sample_rate_hertz=16000
            )
        )
        
        # Silent reconnect loop — every 9 minutes, user never notices
        while self.running:
            try:
                async with self.client.aio.live.connect(
                    model="gemini-2.0-flash-live-001", 
                    config=config
                ) as live:
                    self.live_session = live
                    
                    # Run send and receive concurrently
                    await asyncio.gather(
                        self._receive_from_client(),
                        self._receive_from_gemini(),
                        self._belief_formation_loop()
                    )
            except Exception as e:
                # Silent reconnect after 1s
                await asyncio.sleep(1)
                # Refresh profile before reconnecting
                profile = await self.db.get_profile()
                graph_digest = await self.db.get_graph_digest(max_tokens=400)
    
    async def _receive_from_client(self):
        """Receive audio chunks and events from browser WebSocket."""
        async for message in self.ws.iter_json():
            msg_type = message.get("type")
            
            if msg_type == "audio":
                # Stream mic audio to Gemini Live
                audio_data = base64.b64decode(message["data"])
                await self.live_session.send(
                    types.LiveClientRealtimeInput(
                        media_chunks=[types.Blob(data=audio_data, mime_type="audio/pcm;rate=16000")]
                    )
                )
            
            elif msg_type == "observation":
                # Tab/file/music event from Chrome Extension
                self.observation_buffer.append(message["data"])
            
            elif msg_type == "screen_frame":
                # On-demand screen snapshot (triggered by voice or stuck detection)
                image_data = base64.b64decode(message["data"])
                await self.live_session.send(
                    types.LiveClientRealtimeInput(
                        media_chunks=[types.Blob(data=image_data, mime_type="image/jpeg")]
                    )
                )
    
    async def _receive_from_gemini(self):
        """Stream Gemini Live audio responses back to browser."""
        async for response in self.live_session.receive():
            if response.data:
                # Send audio back to browser for playback
                await self.ws.send_json({
                    "type": "audio",
                    "data": base64.b64encode(response.data).decode()
                })
            if response.text:
                # Send transcript for display
                await self.ws.send_json({"type": "transcript", "text": response.text})
    
    async def _belief_formation_loop(self):
        """Every 60 seconds, process observation buffer into beliefs."""
        while self.running:
            await asyncio.sleep(60)
            if self.observation_buffer:
                batch = self.observation_buffer.copy()
                self.observation_buffer.clear()
                beliefs = await self.belief_engine.process_observation_batch(batch)
                for belief in beliefs:
                    await self.db.add_belief(
                        belief["statement"], belief["confidence"],
                        belief["evidence"], belief["node_type"]
                    )
                # Notify frontend of new nodes
                await self.ws.send_json({"type": "graph_update", "beliefs": beliefs})
    
    def _build_system_prompt(self, profile: str, graph_digest: str) -> str:
        return f"""You are Cortex — ambient intelligence. Profile: {profile[:1500]}
Graph: {graph_digest[:400]}
Speak only when you have something worth saying. When you speak unprompted, it must feel like you read the user's mind."""
    
    async def cleanup(self):
        self.running = False
        # Compress profile with session's beliefs before cleanup
        session_beliefs = await self.db.get_session_beliefs()
        await self.belief_engine.compress_profile(session_beliefs)
```

### 6. firestore_client.py — Database Layer
```python
from google.cloud import firestore
from google.cloud.firestore import AsyncClient
import asyncio, json
from datetime import datetime, timedelta

class FirestoreClient:
    def __init__(self):
        self.db = AsyncClient()
        self.beliefs_col = self.db.collection("beliefs")
        self.edges_col = self.db.collection("edges")
        self.profile_doc = self.db.collection("meta").document("profile")
        self.sessions_col = self.db.collection("sessions")
    
    async def add_belief(self, statement: str, confidence: float, evidence: list, node_type: str) -> str:
        ref = self.beliefs_col.document()
        await ref.set({
            "statement": statement, "confidence": confidence,
            "evidence": evidence, "node_type": node_type,
            "created_at": firestore.SERVER_TIMESTAMP,
            "session_id": self._current_session_id()
        })
        return ref.id
    
    async def get_belief_graph(self) -> dict:
        """Returns nodes and edges for D3 rendering."""
        beliefs_snap = await self.beliefs_col.order_by(
            "confidence", direction=firestore.Query.DESCENDING
        ).limit(200).get()
        
        edges_snap = await self.edges_col.limit(500).get()
        
        nodes = [{"id": d.id, **d.to_dict()} for d in beliefs_snap]
        links = [d.to_dict() for d in edges_snap]
        return {"nodes": nodes, "links": links}
    
    async def get_profile(self) -> str:
        doc = await self.profile_doc.get()
        if doc.exists:
            return doc.to_dict().get("content", "No profile yet. User is new.")
        return "No profile yet."
    
    async def save_profile(self, content: str):
        await self.profile_doc.set({"content": content, "updated_at": firestore.SERVER_TIMESTAMP})
    
    async def get_graph_digest(self, max_tokens: int = 400) -> str:
        """Returns a short summary of active belief clusters for context injection."""
        beliefs_snap = await self.beliefs_col.order_by(
            "created_at", direction=firestore.Query.DESCENDING
        ).limit(20).get()
        
        recent = [d.to_dict().get("statement", "") for d in beliefs_snap]
        digest = " | ".join(recent[:10])
        return digest[:max_tokens * 4]  # rough token estimate
    
    async def find_session(self, description: str) -> dict:
        # Query Firestore for session matching the description
        # Returns tab list, file list, cluster summary
        sessions = await self.sessions_col.order_by(
            "created_at", direction=firestore.Query.DESCENDING
        ).limit(20).get()
        return sessions[0].to_dict() if sessions else {}
    
    def _current_session_id(self) -> str:
        return datetime.now().strftime("%Y%m%d_%H")
    
    # Sync versions for ADK tools (called from sync context)
    def add_belief_sync(self, statement, confidence, evidence, node_type):
        return asyncio.get_event_loop().run_until_complete(
            self.add_belief(statement, confidence, evidence, node_type)
        )
    
    def get_recent_beliefs_sync(self, limit=50):
        async def _get():
            snap = await self.beliefs_col.order_by(
                "created_at", direction=firestore.Query.DESCENDING
            ).limit(limit).get()
            return [{"id": d.id, **d.to_dict()} for d in snap]
        return asyncio.get_event_loop().run_until_complete(_get())
    
    def get_contact_sync(self, name: str):
        async def _get():
            snap = await self.beliefs_col.where("node_type", "==", "contact").where(
                "statement", ">=", name
            ).limit(3).get()
            return [d.to_dict() for d in snap]
        return asyncio.get_event_loop().run_until_complete(_get())
    
    def get_beliefs_by_ids_sync(self, ids: list):
        async def _get():
            results = []
            for id_ in ids:
                doc = await self.beliefs_col.document(id_).get()
                if doc.exists:
                    results.append(doc.to_dict())
            return results
        return asyncio.get_event_loop().run_until_complete(_get())
    
    def get_cluster_sync(self, cluster_name: str):
        return self.get_recent_beliefs_sync(limit=20)
    
    def add_edge_sync(self, a, b, rel):
        async def _add():
            await self.edges_col.add({"source": a, "target": b, "relationship": rel,
                                       "created_at": firestore.SERVER_TIMESTAMP})
        asyncio.get_event_loop().run_until_complete(_add())
    
    async def get_session_beliefs(self):
        session_id = self._current_session_id()
        snap = await self.beliefs_col.where("session_id", "==", session_id).get()
        return [d.to_dict() for d in snap]
```

### 7. Dockerfile
```dockerfile
FROM python:3.11-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 8080
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080"]
```

---

## CHROME EXTENSION — BUILD SECOND

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Cortex Observer",
  "version": "1.0",
  "description": "Ambient tab and activity observer for Cortex",
  "permissions": ["tabs", "history", "storage", "scripting"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "popup.html" }
}
```

### background.js
```javascript
// Connects to Cortex backend WebSocket and streams tab events
const BACKEND_WS = "ws://localhost:8080/ws"; // Change to Cloud Run URL for prod

let socket = null;
let tabDwell = {}; // Track time spent per tab

function connect() {
  socket = new WebSocket(BACKEND_WS);
  socket.onclose = () => setTimeout(connect, 2000); // Auto-reconnect
}
connect();

function sendObservation(data) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "observation", data }));
  }
}

// Tab dwell time tracking (filter out <30s tabs)
chrome.tabs.onActivated.addListener(({ tabId }) => {
  tabDwell[tabId] = Date.now();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url && !tab.url.startsWith("chrome://")) {
    sendObservation({
      event: "tab_visit",
      url: tab.url,
      title: tab.title,
      timestamp: Date.now()
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const dwell = tabDwell[tabId] ? Date.now() - tabDwell[tabId] : 0;
  if (dwell > 30000) { // Only report tabs open >30 seconds
    chrome.tabs.get(tabId, (tab) => {
      if (tab) sendObservation({ event: "tab_closed", url: tab.url, dwell_ms: dwell });
    });
  }
  delete tabDwell[tabId];
});

// Listen for commands from Cortex (open/close tabs)
socket.onmessage = async (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "manage_tabs") {
    if (msg.action === "open") {
      msg.urls?.forEach(url => chrome.tabs.create({ url }));
    } else if (msg.action === "close") {
      const tabs = await chrome.tabs.query({});
      tabs.filter(t => msg.filter && t.url?.includes(msg.filter))
          .forEach(t => chrome.tabs.remove(t.id));
    }
  }
};
```

---

## FRONTEND — BUILD THIRD

Key React components to implement (these integrate with the D3 graph already created earlier):

### useFirestore.js — Real-time Graph Subscription
```javascript
import { initializeApp } from "firebase/app";
import { getFirestore, collection, onSnapshot, query, orderBy, limit } from "firebase/firestore";
import { useEffect, useState } from "react";

const firebaseConfig = {
  // Copy from GCP Console → Firebase → Project Settings
  projectId: process.env.REACT_APP_PROJECT_ID,
  // ... other config
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export function useBeliefGraph() {
  const [nodes, setNodes] = useState([]);
  const [links, setLinks] = useState([]);

  useEffect(() => {
    // Real-time subscription to beliefs collection
    const q = query(collection(db, "beliefs"), orderBy("confidence", "desc"), limit(200));
    const unsub = onSnapshot(q, (snap) => {
      setNodes(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
    return unsub;
  }, []);

  return { nodes, links };
}
```

### VoiceIndicator.jsx
```jsx
import { useEffect, useRef, useState } from "react";

export default function VoiceIndicator({ wsRef }) {
  const [status, setStatus] = useState("idle"); // idle | listening | speaking | thinking
  const [transcript, setTranscript] = useState("");
  const audioCtx = useRef(null);
  const mediaStream = useRef(null);

  const startListening = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaStream.current = stream;
    audioCtx.current = new AudioContext({ sampleRate: 16000 });
    
    const source = audioCtx.current.createMediaStreamSource(stream);
    const processor = audioCtx.current.createScriptProcessor(4096, 1, 1);
    
    processor.onaudioprocess = (e) => {
      const pcm = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) int16[i] = pcm[i] * 32768;
      const b64 = btoa(String.fromCharCode(...new Uint8Array(int16.buffer)));
      wsRef.current?.send(JSON.stringify({ type: "audio", data: b64 }));
    };
    
    source.connect(processor);
    processor.connect(audioCtx.current.destination);
    setStatus("listening");
  };

  // Receive audio from Gemini and play back
  useEffect(() => {
    if (!wsRef.current) return;
    wsRef.current.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === "audio") {
        setStatus("speaking");
        // Decode and play PCM audio
        const binary = atob(msg.data);
        const buf = new ArrayBuffer(binary.length);
        const view = new Uint8Array(buf);
        for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
        // ... play via Web Audio API
      }
      if (msg.type === "transcript") setTranscript(msg.text);
      if (msg.type === "graph_update") setStatus("listening");
    };
  }, [wsRef]);

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 20 }}>
      <button onClick={startListening}
        style={{ background: status === "speaking" ? "#4af0b0" : "#1a1e2a",
                 border: "1px solid #4af0b0", borderRadius: "50%",
                 width: 56, height: 56, cursor: "pointer",
                 boxShadow: status !== "idle" ? "0 0 20px rgba(74,240,176,0.5)" : "none" }}>
        🎙
      </button>
      {transcript && (
        <div style={{ position: "absolute", bottom: 70, right: 0, width: 280,
                      background: "rgba(17,20,27,0.95)", border: "1px solid rgba(255,255,255,0.07)",
                      borderRadius: 6, padding: 12, fontSize: 11, color: "#c8d0e0" }}>
          {transcript}
        </div>
      )}
    </div>
  );
}
```

---

## CLOUD DEPLOYMENT

### Deploy backend to Cloud Run (run after local testing works):
```bash
cd cortex/backend

# Build and push container
gcloud builds submit --tag gcr.io/$PROJECT_ID/cortex-backend

# Deploy to Cloud Run
gcloud run deploy cortex-backend \
  --image gcr.io/$PROJECT_ID/cortex-backend \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_API_KEY=$GOOGLE_API_KEY,PROJECT_ID=$PROJECT_ID \
  --memory 1Gi \
  --concurrency 100

# Get the deployed URL
export BACKEND_URL=$(gcloud run services describe cortex-backend \
  --platform managed --region us-central1 --format 'value(status.url)')
echo "Backend: $BACKEND_URL"
```

### Firestore setup:
```bash
# Enable Firestore in your GCP project
gcloud firestore databases create --location=us-central1

# Create indexes (run from project root)
cat > firestore.indexes.json << 'EOF'
{
  "indexes": [
    {
      "collectionGroup": "beliefs",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "confidence", "order": "DESCENDING" },
        { "fieldPath": "created_at", "order": "DESCENDING" }
      ]
    }
  ]
}
EOF
firebase deploy --only firestore:indexes
```

---

## IaC BONUS (terraform/main.tf)
```hcl
terraform {
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.0" }
  }
}

variable "project_id" {}
variable "api_key" {}

provider "google" { project = var.project_id, region = "us-central1" }

resource "google_cloud_run_v2_service" "cortex_backend" {
  name     = "cortex-backend"
  location = "us-central1"
  
  template {
    containers {
      image = "gcr.io/${var.project_id}/cortex-backend:latest"
      env { name = "GOOGLE_API_KEY", value = var.api_key }
      env { name = "PROJECT_ID",     value = var.project_id }
      resources { limits = { memory = "1Gi", cpu = "1" } }
    }
  }
  
  traffic { type = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST", percent = 100 }
}

resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.cortex_backend.name
  location = google_cloud_run_v2_service.cortex_backend.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

output "backend_url" { value = google_cloud_run_v2_service.cortex_backend.uri }
```

Deploy with:
```bash
cd terraform
terraform init
terraform apply -var="project_id=$PROJECT_ID" -var="api_key=$GOOGLE_API_KEY"
```

---

## LOCAL DEV SETUP (docker-compose.yml)
```yaml
version: "3.9"
services:
  backend:
    build: ./backend
    ports: ["8080:8080"]
    environment:
      - GOOGLE_API_KEY=${GOOGLE_API_KEY}
      - PROJECT_ID=${PROJECT_ID}
      - GOOGLE_APPLICATION_CREDENTIALS=/app/creds.json
    volumes:
      - ./creds.json:/app/creds.json:ro
  
  frontend:
    build: ./frontend
    ports: ["3000:3000"]
    environment:
      - REACT_APP_BACKEND_WS=ws://localhost:8080/ws
      - REACT_APP_PROJECT_ID=${PROJECT_ID}
    depends_on: [backend]
```

---

## GCP PROOF VIDEO CHECKLIST (required for submission)

Record a 1-2 min screen capture showing:
1. `console.cloud.google.com/run` → cortex-backend service → STATUS: RUNNING
2. `console.cloud.google.com/firestore` → beliefs collection → live nodes populating
3. `console.cloud.google.com/logs` → Cloud Run logs showing Gemini API calls
4. Copy the Cloud Run URL and show it responding to `GET /health`

---

## README SPIN-UP (copy this for your repo)

```markdown
## Cortex — Local Setup

### Prerequisites
- Python 3.11+, Node 18+, Docker
- Google Cloud CLI authenticated
- Chrome browser

### 1. Environment
cp .env.example .env
# Fill in: GOOGLE_API_KEY, PROJECT_ID

### 2. Backend
cd backend && pip install -r requirements.txt
uvicorn main:app --reload --port 8080

### 3. Chrome Extension
chrome://extensions → Enable Developer Mode → Load Unpacked → select /extension

### 4. Frontend  
cd frontend && npm install && npm start

### 5. Cloud Deployment
gcloud builds submit --tag gcr.io/$PROJECT_ID/cortex-backend ./backend
gcloud run deploy cortex-backend --image gcr.io/$PROJECT_ID/cortex-backend \
  --platform managed --region us-central1 --allow-unauthenticated
```

---

## HACKATHON JUDGING CRITERIA — HOW CORTEX SCORES

| Criterion | Weight | Cortex Approach |
|---|---|---|
| Innovation & Multimodal UX | 40% | No product combines ambient belief formation + live voice + workspace restoration + graph viz |
| Technical Implementation | 30% | Belief system, context compression, Chrome extension, real-time D3 sync |
| Demo & Presentation | 30% | 3 visceral moments: insight → restoration → email in 7 words |
| Bonus: IaC | +pts | Terraform Cloud Run deploy |
| Bonus: Blog post | +pts | Publish on Medium: "How we built a belief engine on Gemini" |

---

## THE THREE DEMO MOMENTS (practice these)

**Moment 1 — Insight (0:30)**
"What have I been working on today?"
→ Agent gives specific, graph-grounded, accurate answer. Graph highlights clusters.

**Moment 2 — Restoration (1:00)**
"Take me back to where I was an hour ago."
→ Tabs reopen. Files surface. Agent narrates. Graph animates the historical cluster.

**Moment 3 — Email (1:30)**
"Draft an email to my advisor about the research I was reading."
→ Gmail opens. Email is addressed correctly. Sounds like you wrote it. You said 7 words.

THE WIN: Judges realize the email was right — not because you explained anything, but because the agent already knew.
```
