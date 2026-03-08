from google import genai
from google.genai import types
import asyncio
import os
import base64
from agent import build_cortex_agent
from firestore_client import FirestoreClient
from beliefs import BeliefEngine


class CortexSession:
    def __init__(self, websocket, db: FirestoreClient, belief_engine: BeliefEngine):
        self.ws = websocket
        self.db = db
        self.belief_engine = belief_engine
        self.client = genai.Client(api_key=os.environ.get("GOOGLE_API_KEY", ""))
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
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(
                        voice_name="Puck"
                    )
                )
            ),
        )

        # Silent reconnect loop — every 9 minutes, user never notices
        while self.running:
            try:
                async with self.client.aio.live.connect(
                    model="gemini-2.0-flash-live-001", config=config
                ) as live:
                    self.live_session = live

                    # Run send and receive concurrently
                    await asyncio.gather(
                        self._receive_from_client(),
                        self._receive_from_gemini(),
                        self._belief_formation_loop(),
                    )
            except Exception as e:
                print(f"[CortexSession] Connection error: {e}, reconnecting...")
                await asyncio.sleep(1)
                # Refresh profile before reconnecting
                profile = await self.db.get_profile()
                graph_digest = await self.db.get_graph_digest(max_tokens=400)
                config = types.LiveConnectConfig(
                    response_modalities=["AUDIO"],
                    system_instruction=self._build_system_prompt(
                        profile, graph_digest
                    ),
                    speech_config=types.SpeechConfig(
                        voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(
                                voice_name="Puck"
                            )
                        )
                    ),
                )

    async def _receive_from_client(self):
        """Receive audio chunks and events from browser WebSocket."""
        async for message in self.ws.iter_json():
            msg_type = message.get("type")

            if msg_type == "audio":
                # Stream mic audio to Gemini Live
                audio_data = base64.b64decode(message["data"])
                await self.live_session.send(
                    types.LiveClientRealtimeInput(
                        media_chunks=[
                            types.Blob(
                                data=audio_data, mime_type="audio/pcm;rate=16000"
                            )
                        ]
                    )
                )

            elif msg_type == "observation":
                # Tab/file/music event from Chrome Extension
                self.observation_buffer.append(message["data"])

            elif msg_type == "screen_frame":
                # On-demand screen snapshot
                image_data = base64.b64decode(message["data"])
                await self.live_session.send(
                    types.LiveClientRealtimeInput(
                        media_chunks=[
                            types.Blob(data=image_data, mime_type="image/jpeg")
                        ]
                    )
                )

    async def _receive_from_gemini(self):
        """Stream Gemini Live audio responses back to browser."""
        async for response in self.live_session.receive():
            if response.data:
                await self.ws.send_json(
                    {
                        "type": "audio",
                        "data": base64.b64encode(response.data).decode(),
                    }
                )
            if response.text:
                await self.ws.send_json(
                    {"type": "transcript", "text": response.text}
                )

    async def _belief_formation_loop(self):
        """Every 60 seconds, process observation buffer into beliefs."""
        while self.running:
            await asyncio.sleep(60)
            if self.observation_buffer:
                batch = self.observation_buffer.copy()
                self.observation_buffer.clear()

                beliefs = await self.belief_engine.process_observation_batch(batch)

                for belief in beliefs:
                    node_id = await self.db.add_belief(
                        belief["statement"],
                        belief["confidence"],
                        belief["evidence"],
                        belief["node_type"],
                    )

                    # Connect to existing nodes if specified
                    for target_id in belief.get("connect_to", []):
                        if target_id:
                            await self.db.add_edge(
                                node_id, target_id, "related_to"
                            )

                # Save session snapshot for restoration
                if beliefs:
                    await self.db.save_session(
                        {
                            "summary": " | ".join(
                                b["statement"] for b in beliefs[:5]
                            ),
                            "tabs": [
                                o.get("url", "")
                                for o in batch
                                if o.get("event") == "tab_visit"
                            ],
                            "files": [],
                        }
                    )

                # Notify frontend of new nodes
                try:
                    await self.ws.send_json(
                        {"type": "graph_update", "beliefs": beliefs}
                    )
                except Exception:
                    pass

    def _build_system_prompt(self, profile: str, graph_digest: str) -> str:
        return (
            f"You are Cortex — ambient intelligence. Profile: {profile[:1500]}\n"
            f"Graph: {graph_digest[:400]}\n"
            "Speak only when you have something worth saying. "
            "When you speak unprompted, it must feel like you read the user's mind."
        )

    async def cleanup(self):
        self.running = False
        try:
            session_beliefs = await self.db.get_session_beliefs()
            await self.belief_engine.compress_profile(session_beliefs)
        except Exception as e:
            print(f"[CortexSession] Cleanup error: {e}")
