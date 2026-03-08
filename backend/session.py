from google import genai
from google.genai import types
import asyncio
import os
import base64
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
        print("[CortexSession] Session started")

        # Run observation processing and client receiving independently
        # Gemini Live is optional — beliefs work without it
        await asyncio.gather(
            self._receive_from_client(),
            self._belief_formation_loop(),
            self._gemini_live_loop(),
        )

    async def _receive_from_client(self):
        """Receive observations and audio from the WebSocket client."""
        try:
            async for message in self.ws.iter_json():
                msg_type = message.get("type")

                if msg_type == "observation":
                    self.observation_buffer.append(message["data"])
                    print(f"[CortexSession] Observation received: {message['data'].get('event', 'unknown')}")

                elif msg_type == "audio" and self.live_session:
                    audio_data = base64.b64decode(message["data"])
                    try:
                        await self.live_session.send(
                            types.LiveClientRealtimeInput(
                                media_chunks=[
                                    types.Blob(
                                        data=audio_data,
                                        mime_type="audio/pcm;rate=16000",
                                    )
                                ]
                            )
                        )
                    except Exception as e:
                        print(f"[CortexSession] Audio send error: {e}")

                elif msg_type == "screen_frame" and self.live_session:
                    image_data = base64.b64decode(message["data"])
                    try:
                        await self.live_session.send(
                            types.LiveClientRealtimeInput(
                                media_chunks=[
                                    types.Blob(
                                        data=image_data,
                                        mime_type="image/jpeg",
                                    )
                                ]
                            )
                        )
                    except Exception as e:
                        print(f"[CortexSession] Screen send error: {e}")

        except Exception as e:
            print(f"[CortexSession] Client receive error: {e}")
            self.running = False

    async def _belief_formation_loop(self):
        """Every 30 seconds, process observation buffer into beliefs.
        This runs INDEPENDENTLY of Gemini Live."""
        # Process first batch quickly (after 5 seconds)
        first_run = True
        while self.running:
            wait_time = 5 if first_run else 30
            first_run = False
            await asyncio.sleep(wait_time)

            if not self.observation_buffer:
                continue

            batch = self.observation_buffer.copy()
            self.observation_buffer.clear()
            print(f"[CortexSession] Processing {len(batch)} observations...")

            try:
                beliefs = await self.belief_engine.process_observation_batch(batch)
                print(f"[CortexSession] Formed {len(beliefs)} beliefs")

                for belief in beliefs:
                    node_id = await self.db.add_belief(
                        belief["statement"],
                        belief["confidence"],
                        belief["evidence"],
                        belief["node_type"],
                    )

                    for target_id in belief.get("connect_to", []):
                        if target_id:
                            await self.db.add_edge(
                                node_id, target_id, "related_to"
                            )

                # Save session snapshot
                if beliefs:
                    tab_urls = [
                        o.get("url", "")
                        for o in batch
                        if o.get("event") in ("tab_visit", "browser_snapshot")
                    ]
                    # Also extract URLs from browser_snapshot tabs
                    for o in batch:
                        if o.get("event") == "browser_snapshot":
                            for tab in o.get("tabs", []):
                                tab_urls.append(tab.get("url", ""))

                    await self.db.save_session(
                        {
                            "summary": " | ".join(
                                b["statement"] for b in beliefs[:5]
                            ),
                            "tabs": tab_urls[:20],
                            "files": [
                                o.get("path", "")
                                for o in batch
                                if o.get("event") in ("file_modified", "file_created")
                            ],
                        }
                    )

                # Notify frontend
                try:
                    await self.ws.send_json(
                        {"type": "graph_update", "beliefs": beliefs}
                    )
                except Exception:
                    pass

            except Exception as e:
                print(f"[CortexSession] Belief formation error: {e}")

    async def _gemini_live_loop(self):
        """Optionally connect to Gemini Live for voice. Does NOT block beliefs."""
        profile = await self.db.get_profile()
        graph_digest = await self.db.get_graph_digest(max_tokens=400)

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

        while self.running:
            try:
                async with self.client.aio.live.connect(
                    model="gemini-2.0-flash-live-001", config=config
                ) as live:
                    self.live_session = live
                    print("[CortexSession] Gemini Live connected")

                    # Stream responses back to client
                    async for response in live.receive():
                        if not self.running:
                            break
                        if response.data:
                            try:
                                await self.ws.send_json(
                                    {
                                        "type": "audio",
                                        "data": base64.b64encode(
                                            response.data
                                        ).decode(),
                                    }
                                )
                            except Exception:
                                break
                        if response.text:
                            try:
                                await self.ws.send_json(
                                    {"type": "transcript", "text": response.text}
                                )
                            except Exception:
                                break

            except Exception as e:
                self.live_session = None
                print(f"[CortexSession] Gemini Live error (beliefs still working): {e}")
                await asyncio.sleep(5)

                # Refresh context
                try:
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
