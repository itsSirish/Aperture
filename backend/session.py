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
        project_id = os.environ.get("PROJECT_ID", "")
        if project_id:
            self.client = genai.Client(
                vertexai=True,
                project=project_id,
                location=os.environ.get("REGION", "us-central1"),
            )
        else:
            self.client = genai.Client(api_key=os.environ.get("GOOGLE_API_KEY", ""))
        self.live_session = None
        self.running = False
        self.observation_buffer = []

    async def run(self):
        self.running = True
        print("[CortexSession] Session started")

        await asyncio.gather(
            self._receive_from_client(),
            self._process_observations_loop(),
            self._gemini_live_loop(),
        )

    async def _receive_from_client(self):
        try:
            async for message in self.ws.iter_json():
                msg_type = message.get("type")

                if msg_type == "observation":
                    data = message["data"]
                    event = data.get("event", "")
                    print(f"[CortexSession] Observation: {event}")

                    # Store concrete items directly as nodes
                    await self._store_observation(data)

                    # Also buffer for belief synthesis
                    self.observation_buffer.append(data)

                elif msg_type == "audio" and self.live_session:
                    audio_data = base64.b64decode(message["data"])
                    try:
                        await self.live_session.send(
                            types.LiveClientRealtimeInput(
                                media_chunks=[types.Blob(data=audio_data, mime_type="audio/pcm;rate=16000")]
                            )
                        )
                    except Exception as e:
                        print(f"[CortexSession] Audio send error: {e}")

        except Exception as e:
            print(f"[CortexSession] Client receive error: {e}")
            self.running = False

    async def _store_observation(self, data):
        """Store raw observations as concrete graph nodes with smart grouping."""
        event = data.get("event", "")

        if event == "directory_scan":
            directory = data.get("directory", "")
            files = data.get("files", [])
            folder_name = directory.split("/")[-1] if "/" in directory else directory
            dir_id = await self.db.add_belief(
                statement=folder_name,
                confidence=1.0,
                evidence=[directory],
                node_type="folder",
            )
            # Group files by extension
            by_ext = {}
            for f in files:
                ext = f.get("extension", "").lower()
                if ext not in by_ext:
                    by_ext[ext] = []
                by_ext[ext].append(f)

            for ext, ext_files in by_ext.items():
                # Only store top 5 biggest/most recent per extension
                sorted_files = sorted(ext_files, key=lambda x: x.get("size_kb", 0), reverse=True)[:5]
                for f in sorted_files:
                    file_id = await self.db.add_belief(
                        statement=f.get("name", ""),
                        confidence=0.5 + min(f.get("size_kb", 0) / 500, 0.5),
                        evidence=[f.get("path", ""), ext, f"{f.get('size_kb', 0)}KB"],
                        node_type="file",
                    )
                    await self.db.add_edge(file_id, dir_id, "inside")

        elif event == "browser_snapshot":
            tabs = data.get("tabs", [])
            # Use Gemini to smart-cluster tabs into topics
            tab_list = []
            for tab in tabs:
                url = tab.get("url", "")
                title = tab.get("title", "")
                if not url or url.startswith("chrome") or not title:
                    continue
                tab_list.append({"url": url, "title": title})

            if tab_list:
                await self._smart_cluster_tabs(tab_list)

        elif event == "notes_scan":
            notes = data.get("notes", [])
            for note_title in notes[:10]:
                if note_title:
                    await self.db.add_belief(
                        statement=note_title,
                        confidence=0.7,
                        evidence=["apple_notes"],
                        node_type="note",
                    )

        elif event == "music_playing":
            track = data.get("track", "")
            artist = data.get("artist", "")
            if track:
                await self.db.add_belief(
                    statement=f"{track} — {artist}",
                    confidence=0.8,
                    evidence=[data.get("album", ""), "now_playing"],
                    node_type="music",
                )

        elif event == "app_focus":
            app = data.get("app", "")
            window = data.get("window", "")
            ignore = {"Finder", "loginwindow", "Dock", "SystemUIServer", "Control Center", "Window Server", "Spotlight"}
            if app and app not in ignore:
                await self.db.add_belief(
                    statement=app,
                    confidence=0.6,
                    evidence=["app_focus", window or ""],
                    node_type="app",
                )

        elif event in ("file_modified", "file_created"):
            name = data.get("name", "")
            path = data.get("path", "")
            if name:
                await self.db.add_belief(
                    statement=name,
                    confidence=0.8,
                    evidence=[path, event],
                    node_type="file",
                )

    async def _smart_cluster_tabs(self, tabs):
        """Use Gemini to group browser tabs into meaningful topics."""
        import json
        tab_summary = "\n".join([f"- {t['title']} ({t['url'][:60]})" for t in tabs[:40]])

        prompt = f"""Group these browser tabs into 3-6 meaningful topic clusters.
Each cluster should have a short name (2-4 words) and list which tabs belong to it.
Ignore generic/utility tabs (new tab, settings, extensions).

TABS:
{tab_summary}

OUTPUT as JSON array:
[
  {{
    "topic": "Job Search",
    "tabs": ["tab title 1", "tab title 2"]
  }}
]

Return ONLY JSON. No markdown. Max 6 clusters. Skip tabs that don't fit any topic."""

        try:
            response = await self.belief_engine.client.aio.models.generate_content(
                model="gemini-2.0-flash", contents=prompt
            )
            raw = response.text.strip()
            if raw.startswith("```"):
                raw = raw.split("```")[1].replace("json", "").strip()

            clusters = json.loads(raw)

            for cluster in clusters:
                topic = cluster.get("topic", "")
                cluster_tabs = cluster.get("tabs", [])
                if not topic or not cluster_tabs:
                    continue

                # Create topic node
                topic_id = await self.db.add_belief(
                    statement=topic,
                    confidence=0.9,
                    evidence=[f"{len(cluster_tabs)} tabs"],
                    node_type="topic",
                )

                # Create tab nodes under the topic
                for tab_title in cluster_tabs[:6]:
                    # Find the URL
                    url = ""
                    for t in tabs:
                        if t["title"] == tab_title:
                            url = t["url"]
                            break
                    if len(tab_title) > 50:
                        tab_title = tab_title[:50] + "..."
                    tab_id = await self.db.add_belief(
                        statement=tab_title,
                        confidence=0.6,
                        evidence=[url],
                        node_type="tab",
                    )
                    await self.db.add_edge(tab_id, topic_id, "part_of")

        except Exception as e:
            print(f"[CortexSession] Tab clustering error: {e}")
            # Fallback: just store domains
            domains = {}
            for t in tabs:
                try:
                    domain = t["url"].split("//")[1].split("/")[0].replace("www.", "")
                except (IndexError, AttributeError):
                    continue
                if domain not in domains:
                    domains[domain] = 0
                domains[domain] += 1

            for domain, count in list(domains.items())[:10]:
                await self.db.add_belief(
                    statement=domain,
                    confidence=min(0.5 + count * 0.1, 1.0),
                    evidence=[f"{count} tabs"],
                    node_type="domain",
                )

    async def _process_observations_loop(self):
        """Periodically run belief synthesis for higher-level insights."""
        while self.running:
            await asyncio.sleep(120)  # every 2 minutes
            if len(self.observation_buffer) >= 3:
                batch = self.observation_buffer.copy()
                self.observation_buffer.clear()
                try:
                    beliefs = await self.belief_engine.process_observation_batch(batch)
                    print(f"[CortexSession] Synthesized {len(beliefs)} insights")
                    for belief in beliefs:
                        await self.db.add_belief(
                            belief["statement"], belief["confidence"],
                            belief["evidence"], belief["node_type"],
                        )
                except Exception as e:
                    print(f"[CortexSession] Belief synthesis error: {e}")

    async def _gemini_live_loop(self):
        profile = await self.db.get_profile()
        graph_digest = await self.db.get_graph_digest(max_tokens=400)

        config = types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            system_instruction=(
                f"You are Cortex — ambient intelligence. Profile: {profile[:1500]}\n"
                f"Graph: {graph_digest[:400]}\n"
                "Speak only when you have something worth saying."
            ),
            speech_config=types.SpeechConfig(
                voice_config=types.VoiceConfig(
                    prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name="Puck")
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
                    async for response in live.receive():
                        if not self.running:
                            break
                        if response.data:
                            try:
                                await self.ws.send_json({
                                    "type": "audio",
                                    "data": base64.b64encode(response.data).decode(),
                                })
                            except Exception:
                                break
                        if response.text:
                            try:
                                await self.ws.send_json({"type": "transcript", "text": response.text})
                            except Exception:
                                break
            except Exception as e:
                self.live_session = None
                print(f"[CortexSession] Gemini Live error (graph still working): {e}")
                await asyncio.sleep(10)

    async def cleanup(self):
        self.running = False
        try:
            session_beliefs = await self.db.get_session_beliefs()
            await self.belief_engine.compress_profile(session_beliefs)
        except Exception as e:
            print(f"[CortexSession] Cleanup error: {e}")
