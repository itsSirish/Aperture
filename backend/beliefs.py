from google import genai
from google.genai import types
import json
import os
from firestore_client import FirestoreClient


class BeliefEngine:
    def __init__(self, db: FirestoreClient):
        self.db = db
        # Use Vertex AI (project billing) if PROJECT_ID is set, otherwise API key
        project_id = os.environ.get("PROJECT_ID", "")
        api_key = os.environ.get("GOOGLE_API_KEY", "")
        if project_id:
            self.client = genai.Client(
                vertexai=True,
                project=project_id,
                location=os.environ.get("REGION", "us-central1"),
            )
        else:
            self.client = genai.Client(api_key=api_key)

    async def process_observation_batch(self, observations: list[dict]) -> list[dict]:
        """
        Converts raw observations into belief nodes using Gemini Flash.
        Called every 60 seconds with the batch of tab/file/music events.
        """
        if not observations:
            return []

        existing_profile = await self.db.get_profile()

        prompt = f"""You are forming beliefs from behavioral observations. NOT storing raw data — forming INTERPRETED beliefs.

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
  "connect_to": []
}}

Return ONLY the JSON array. No explanation. No markdown.
Maximum 5 beliefs per batch. Quality over quantity."""

        try:
            response = await self.client.aio.models.generate_content(
                model="gemini-2.0-flash", contents=prompt
            )

            raw = response.text.strip()
            if raw.startswith("```"):
                raw = raw.split("```")[1].replace("json", "").strip()

            return json.loads(raw)
        except Exception as e:
            print(f"[BeliefEngine] Error processing batch: {e}")
            return []

    async def compress_profile(self, session_beliefs: list[dict]) -> str:
        """
        After each session, rewrite the 2000-token profile to absorb new beliefs.
        This is the core of why context never rots.
        """
        if not session_beliefs:
            return await self.db.get_profile()

        current_profile = await self.db.get_profile()

        prompt = f"""You are rewriting a compressed user intelligence profile.
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

Output the profile text only. No headers. No JSON."""

        try:
            response = await self.client.aio.models.generate_content(
                model="gemini-2.0-flash",
                contents=prompt,
                config=types.GenerateContentConfig(max_output_tokens=2100),
            )

            new_profile = response.text.strip()
            await self.db.save_profile(new_profile)
            return new_profile
        except Exception as e:
            print(f"[BeliefEngine] Error compressing profile: {e}")
            return current_profile
