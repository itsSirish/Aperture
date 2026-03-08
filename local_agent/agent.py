#!/usr/bin/env python3
"""
Cortex Local Agent — OS-level observer for macOS
Watches: filesystem, active apps/windows, browser tabs, music, notes
Sends observations to Cortex backend via WebSocket
"""

import asyncio
import json
import os
import platform
import subprocess
import time
from pathlib import Path
from datetime import datetime

import websockets
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

# ── Config ─────────────────────────────────────────────────────────────

BACKEND_WS = os.environ.get("CORTEX_BACKEND_WS", "ws://localhost:8080/ws")

# Directories to watch for file changes
WATCH_DIRS = [
    str(Path.home() / "Desktop"),
    str(Path.home() / "Documents"),
    str(Path.home() / "Downloads"),
    str(Path.home() / "Projects"),
    str(Path.home() / "Developer"),
    str(Path.home() / "Code"),
    str(Path.home() / "Notes"),
]

# File types we care about
RELEVANT_EXTENSIONS = {
    ".py", ".js", ".jsx", ".ts", ".tsx", ".java", ".go", ".rs",
    ".md", ".txt", ".pdf", ".docx", ".doc",
    ".ipynb", ".json", ".yaml", ".yml", ".toml",
    ".html", ".css", ".sql", ".sh",
    ".png", ".jpg", ".jpeg", ".svg", ".fig",
    ".pptx", ".xlsx", ".csv",
}

# Apps to ignore
IGNORE_APPS = {"loginwindow", "Dock", "SystemUIServer", "Control Center"}

ws_connection = None
observation_queue = asyncio.Queue()


# ── macOS Helpers (AppleScript) ────────────────────────────────────────

def run_applescript(script: str) -> str:
    """Run AppleScript and return output."""
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=5
        )
        return result.stdout.strip()
    except Exception:
        return ""


def get_active_app() -> dict:
    """Get the currently focused application and window title."""
    script = '''
    tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        set frontWindow to ""
        try
            set frontWindow to name of front window of (first application process whose frontmost is true)
        end try
        return frontApp & "|" & frontWindow
    end tell
    '''
    result = run_applescript(script)
    if "|" in result:
        app, window = result.split("|", 1)
        return {"app": app, "window": window}
    return {"app": result, "window": ""}


def get_chrome_tabs() -> list:
    """Get all open Chrome tab URLs and titles."""
    script = '''
    tell application "Google Chrome"
        set tabList to {}
        repeat with w in windows
            repeat with t in tabs of w
                set end of tabList to (URL of t) & "||" & (title of t)
            end repeat
        end repeat
        set AppleScript's text item delimiters to ";;;"
        return tabList as text
    end tell
    '''
    result = run_applescript(script)
    if not result:
        return []
    tabs = []
    for item in result.split(";;;"):
        if "||" in item:
            url, title = item.split("||", 1)
            tabs.append({"url": url, "title": title})
    return tabs


def get_safari_tabs() -> list:
    """Get all open Safari tab URLs and titles."""
    script = '''
    tell application "Safari"
        set tabList to {}
        repeat with w in windows
            repeat with t in tabs of w
                set end of tabList to (URL of t) & "||" & (name of t)
            end repeat
        end repeat
        set AppleScript's text item delimiters to ";;;"
        return tabList as text
    end tell
    '''
    result = run_applescript(script)
    if not result:
        return []
    tabs = []
    for item in result.split(";;;"):
        if "||" in item:
            url, title = item.split("||", 1)
            tabs.append({"url": url, "title": title})
    return tabs


def get_spotify_track() -> dict | None:
    """Get currently playing Spotify track."""
    script = '''
    if application "Spotify" is running then
        tell application "Spotify"
            if player state is playing then
                return (name of current track) & "||" & (artist of current track) & "||" & (album of current track)
            end if
        end tell
    end if
    return ""
    '''
    result = run_applescript(script)
    if result and "||" in result:
        parts = result.split("||")
        return {"track": parts[0], "artist": parts[1], "album": parts[2] if len(parts) > 2 else ""}
    return None


def get_apple_music_track() -> dict | None:
    """Get currently playing Apple Music track."""
    script = '''
    if application "Music" is running then
        tell application "Music"
            if player state is playing then
                return (name of current track) & "||" & (artist of current track) & "||" & (album of current track)
            end if
        end tell
    end if
    return ""
    '''
    result = run_applescript(script)
    if result and "||" in result:
        parts = result.split("||")
        return {"track": parts[0], "artist": parts[1], "album": parts[2] if len(parts) > 2 else ""}
    return None


def get_notes_summary() -> list:
    """Get recent Apple Notes titles."""
    script = '''
    tell application "Notes"
        set noteList to {}
        repeat with n in (notes of default account)
            if (count of noteList) > 10 then exit repeat
            set end of noteList to name of n
        end repeat
        set AppleScript's text item delimiters to ";;;"
        return noteList as text
    end tell
    '''
    result = run_applescript(script)
    if result:
        return result.split(";;;")
    return []


def scan_directory_structure(path: str, max_depth: int = 3) -> list:
    """Scan directory and return file tree as observations."""
    files = []
    root = Path(path)
    if not root.exists():
        return files

    for item in root.rglob("*"):
        # Respect max depth
        depth = len(item.relative_to(root).parts)
        if depth > max_depth:
            continue
        # Skip hidden files and common junk
        if any(part.startswith(".") for part in item.parts):
            continue
        if item.is_file() and item.suffix.lower() in RELEVANT_EXTENSIONS:
            try:
                stat = item.stat()
                files.append({
                    "path": str(item),
                    "name": item.name,
                    "extension": item.suffix,
                    "size_kb": round(stat.st_size / 1024, 1),
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                    "folder": str(item.parent.relative_to(root)),
                })
            except (PermissionError, OSError):
                continue
    return files


# ── File System Watcher ───────────────────────────────────────────────

class CortexFileHandler(FileSystemEventHandler):
    """Watches file system changes and queues observations."""

    def __init__(self):
        self.last_events = {}  # debounce rapid events

    def _should_report(self, path: str) -> bool:
        ext = Path(path).suffix.lower()
        if ext not in RELEVANT_EXTENSIONS:
            return False
        # Skip hidden files
        if any(part.startswith(".") for part in Path(path).parts):
            return False
        # Debounce — same file within 5 seconds
        now = time.time()
        if path in self.last_events and now - self.last_events[path] < 5:
            return False
        self.last_events[path] = now
        return True

    def on_modified(self, event):
        if not event.is_directory and self._should_report(event.src_path):
            asyncio.get_event_loop().call_soon_threadsafe(
                observation_queue.put_nowait,
                {
                    "event": "file_modified",
                    "path": event.src_path,
                    "name": Path(event.src_path).name,
                    "extension": Path(event.src_path).suffix,
                    "timestamp": int(time.time() * 1000),
                },
            )

    def on_created(self, event):
        if not event.is_directory and self._should_report(event.src_path):
            asyncio.get_event_loop().call_soon_threadsafe(
                observation_queue.put_nowait,
                {
                    "event": "file_created",
                    "path": event.src_path,
                    "name": Path(event.src_path).name,
                    "extension": Path(event.src_path).suffix,
                    "timestamp": int(time.time() * 1000),
                },
            )

    def on_deleted(self, event):
        if not event.is_directory and self._should_report(event.src_path):
            asyncio.get_event_loop().call_soon_threadsafe(
                observation_queue.put_nowait,
                {
                    "event": "file_deleted",
                    "path": event.src_path,
                    "name": Path(event.src_path).name,
                    "timestamp": int(time.time() * 1000),
                },
            )


# ── Polling Loops ─────────────────────────────────────────────────────

async def poll_active_app(interval: int = 5):
    """Poll active app/window every N seconds."""
    last_app = None
    while True:
        try:
            current = get_active_app()
            app_name = current.get("app", "")
            if app_name and app_name not in IGNORE_APPS and current != last_app:
                await observation_queue.put({
                    "event": "app_focus",
                    "app": app_name,
                    "window": current.get("window", ""),
                    "timestamp": int(time.time() * 1000),
                })
                last_app = current
        except Exception as e:
            print(f"[poll_active_app] Error: {e}")
        await asyncio.sleep(interval)


async def poll_browser_tabs(interval: int = 30):
    """Poll browser tabs every N seconds."""
    last_tabs_hash = None
    while True:
        try:
            tabs = get_chrome_tabs() + get_safari_tabs()
            tabs_hash = hash(json.dumps(tabs, sort_keys=True))
            if tabs and tabs_hash != last_tabs_hash:
                await observation_queue.put({
                    "event": "browser_snapshot",
                    "tabs": tabs,
                    "tab_count": len(tabs),
                    "timestamp": int(time.time() * 1000),
                })
                last_tabs_hash = tabs_hash
        except Exception as e:
            print(f"[poll_browser_tabs] Error: {e}")
        await asyncio.sleep(interval)


async def poll_music(interval: int = 15):
    """Poll currently playing music."""
    last_track = None
    while True:
        try:
            track = get_spotify_track() or get_apple_music_track()
            if track and track != last_track:
                await observation_queue.put({
                    "event": "music_playing",
                    **track,
                    "timestamp": int(time.time() * 1000),
                })
                last_track = track
        except Exception as e:
            print(f"[poll_music] Error: {e}")
        await asyncio.sleep(interval)


async def initial_scan():
    """On startup, scan directories and notes to build initial context."""
    print("[Cortex] Running initial scan...")

    # Scan directories
    for dir_path in WATCH_DIRS:
        if Path(dir_path).exists():
            files = scan_directory_structure(dir_path)
            if files:
                await observation_queue.put({
                    "event": "directory_scan",
                    "directory": dir_path,
                    "files": files[:50],  # limit per directory
                    "total_files": len(files),
                    "timestamp": int(time.time() * 1000),
                })
                print(f"  Scanned {dir_path}: {len(files)} files")

    # Scan Apple Notes
    try:
        notes = get_notes_summary()
        if notes:
            await observation_queue.put({
                "event": "notes_scan",
                "notes": notes,
                "timestamp": int(time.time() * 1000),
            })
            print(f"  Found {len(notes)} Apple Notes")
    except Exception:
        pass

    # Initial browser snapshot
    try:
        tabs = get_chrome_tabs() + get_safari_tabs()
        if tabs:
            await observation_queue.put({
                "event": "browser_snapshot",
                "tabs": tabs,
                "tab_count": len(tabs),
                "timestamp": int(time.time() * 1000),
            })
            print(f"  Found {len(tabs)} browser tabs")
    except Exception:
        pass

    print("[Cortex] Initial scan complete")


# ── WebSocket Sender ──────────────────────────────────────────────────

async def ws_sender():
    """Send queued observations to the backend via WebSocket."""
    global ws_connection
    while True:
        try:
            async with websockets.connect(BACKEND_WS) as ws:
                ws_connection = ws
                print(f"[Cortex] Connected to backend: {BACKEND_WS}")

                while True:
                    observation = await observation_queue.get()
                    message = json.dumps({
                        "type": "observation",
                        "data": observation,
                    })
                    await ws.send(message)

        except (websockets.exceptions.ConnectionClosed, ConnectionRefusedError, OSError) as e:
            print(f"[Cortex] Connection lost ({e}), reconnecting in 3s...")
            ws_connection = None
            await asyncio.sleep(3)
        except Exception as e:
            print(f"[Cortex] WebSocket error: {e}, retrying in 3s...")
            ws_connection = None
            await asyncio.sleep(3)


# ── Main ──────────────────────────────────────────────────────────────

async def main():
    print("=========================================")
    print("  CORTEX LOCAL AGENT")
    print(f"  Platform: {platform.system()} {platform.machine()}")
    print(f"  Backend:  {BACKEND_WS}")
    print("=========================================")
    print()

    if platform.system() != "Darwin":
        print("[!] WARNING: AppleScript features (tabs, music, notes) only work on macOS.")
        print("    File watching will still work on any platform.")
        print()

    # Start filesystem watchers
    observer = Observer()
    handler = CortexFileHandler()
    watched = 0
    for dir_path in WATCH_DIRS:
        if Path(dir_path).exists():
            observer.schedule(handler, dir_path, recursive=True)
            print(f"[Cortex] Watching: {dir_path}")
            watched += 1
    if watched > 0:
        observer.start()
        print(f"[Cortex] File watcher active ({watched} directories)")
    else:
        print("[Cortex] No watch directories found — create ~/Projects, ~/Documents, etc.")

    print()

    # Run initial scan
    await initial_scan()

    print()
    print("[Cortex] Agent running. Press Ctrl+C to stop.")
    print()

    # Run all pollers + WebSocket sender concurrently
    tasks = [
        asyncio.create_task(ws_sender()),
        asyncio.create_task(poll_active_app(interval=5)),
        asyncio.create_task(poll_music(interval=15)),
    ]

    # Only poll browser tabs on macOS (needs AppleScript)
    if platform.system() == "Darwin":
        tasks.append(asyncio.create_task(poll_browser_tabs(interval=30)))

    try:
        await asyncio.gather(*tasks)
    except KeyboardInterrupt:
        pass
    finally:
        observer.stop()
        observer.join()
        print("\n[Cortex] Agent stopped.")


if __name__ == "__main__":
    asyncio.run(main())
