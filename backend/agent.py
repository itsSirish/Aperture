from google.adk.agents import Agent
from google.adk.tools import FunctionTool
from firestore_client import FirestoreClient
import asyncio

db = FirestoreClient()


# ── KNOWLEDGE TOOLS ────────────────────────────────────────────────────


async def add_belief(
    statement: str, confidence: float, evidence: list, node_type: str
) -> dict:
    """
    Forms a new belief node in the graph from an interpreted observation.
    node_type: 'work' | 'contact' | 'project' | 'behavior' | 'intent'
    confidence: 0.0 - 1.0
    evidence: list of source strings e.g. ['tab_pattern', 'voice_note', 'file_edit']
    """
    node_id = await db.add_belief(statement, confidence, evidence, node_type)
    return {"status": "belief_formed", "node_id": node_id, "statement": statement}


async def add_edge(belief_a_id: str, belief_b_id: str, relationship: str) -> dict:
    """
    Connects two belief nodes.
    relationship: 'related_to' | 'caused_by' | 'blocks' | 'part_of' | 'mentions'
    """
    await db.add_edge(belief_a_id, belief_b_id, relationship)
    return {"status": "edge_added", "relationship": relationship}


async def query_graph(question: str) -> dict:
    """
    Reasons over the belief graph to answer a natural language question about the user's work.
    Returns a spoken answer grounded in actual beliefs.
    """
    beliefs = await db.get_recent_beliefs(limit=50)
    return {"beliefs": beliefs, "question": question}


async def restore_session(datetime_or_description: str) -> dict:
    """
    Reconstructs a past working context. Reopens browser tabs, surfaces files,
    returns a spoken summary of what the user was doing at that time.
    datetime_or_description: e.g. 'Tuesday afternoon', '2 hours ago', 'when I was working on Kafka'
    """
    session_data = await db.find_session(datetime_or_description)
    return {
        "tabs_to_open": session_data.get("tabs", []),
        "files_surfaced": session_data.get("files", []),
        "session_summary": session_data.get("summary", ""),
        "graph_cluster": session_data.get("cluster_id"),
    }


async def generate_doc(cluster_name: str, output_format: str) -> dict:
    """
    Synthesizes a graph cluster into a document.
    output_format: 'markdown' | 'pdf'
    """
    cluster = await db.get_cluster(cluster_name)
    return {"status": "generating", "cluster": cluster, "format": output_format}


# ── ACTION TOOLS ───────────────────────────────────────────────────────


async def draft_message(recipient_name: str, context_belief_ids: list) -> dict:
    """
    Drafts an email/message enriched with full graph context about the recipient
    and current work. Returns draft text for user review.
    """
    recipient = await db.get_contact(recipient_name)
    beliefs = await db.get_beliefs_by_ids(context_belief_ids)
    return {
        "recipient": recipient,
        "context_beliefs": beliefs,
        "instruction": "draft email using recipient contact info and belief context",
    }


async def open_search(intent: str) -> dict:
    """
    Generates an intelligent search query from graph context, not generic keywords.
    Intent is what the user wants to find — Cortex adds what it already knows.
    """
    recent_beliefs = await db.get_recent_beliefs(limit=10)
    return {
        "intent": intent,
        "graph_context": recent_beliefs,
        "action": "open_browser_search",
    }


async def manage_tabs(action: str, filter_criteria: str) -> dict:
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
        system_prompt=f"""You are Cortex — a persistent ambient intelligence agent.

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
""",
    )
