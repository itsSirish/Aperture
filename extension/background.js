// Cortex Observer — Background Service Worker
// Connects to Cortex backend WebSocket and streams tab events

const BACKEND_WS_KEY = "cortex_backend_ws";
const DEFAULT_WS = "ws://localhost:8080/ws";

let socket = null;
let tabDwell = {}; // Track time spent per tab
let tabUrls = {}; // Cache tab URLs for onRemoved

function getBackendUrl() {
  return new Promise((resolve) => {
    chrome.storage.local.get(BACKEND_WS_KEY, (result) => {
      resolve(result[BACKEND_WS_KEY] || DEFAULT_WS);
    });
  });
}

async function connect() {
  const url = await getBackendUrl();
  try {
    socket = new WebSocket(url);

    socket.onopen = () => {
      console.log("[Cortex] Connected to backend");
    };

    socket.onclose = () => {
      console.log("[Cortex] Disconnected, reconnecting in 2s...");
      setTimeout(connect, 2000);
    };

    socket.onerror = (err) => {
      console.error("[Cortex] WebSocket error:", err);
    };

    socket.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "manage_tabs") {
          await handleTabCommand(msg);
        }
      } catch (e) {
        console.error("[Cortex] Message parse error:", e);
      }
    };
  } catch (e) {
    console.error("[Cortex] Connect error:", e);
    setTimeout(connect, 2000);
  }
}

function sendObservation(data) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "observation", data }));
  }
}

// ── Tab Event Tracking ────────────────────────────────────────────────

chrome.tabs.onActivated.addListener(({ tabId }) => {
  tabDwell[tabId] = Date.now();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (
    changeInfo.status === "complete" &&
    tab.url &&
    !tab.url.startsWith("chrome://") &&
    !tab.url.startsWith("chrome-extension://")
  ) {
    tabUrls[tabId] = { url: tab.url, title: tab.title };
    sendObservation({
      event: "tab_visit",
      url: tab.url,
      title: tab.title,
      timestamp: Date.now(),
    });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const dwell = tabDwell[tabId] ? Date.now() - tabDwell[tabId] : 0;
  const tabInfo = tabUrls[tabId];

  if (dwell > 30000 && tabInfo) {
    sendObservation({
      event: "tab_closed",
      url: tabInfo.url,
      title: tabInfo.title,
      dwell_ms: dwell,
      timestamp: Date.now(),
    });
  }

  delete tabDwell[tabId];
  delete tabUrls[tabId];
});

// Track tab focus changes across windows
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab) {
      tabDwell[tab.id] = Date.now();
    }
  } catch (e) {
    // Window might have been closed
  }
});

// ── Tab Commands from Cortex ──────────────────────────────────────────

async function handleTabCommand(msg) {
  if (msg.action === "open") {
    const urls = msg.urls || [];
    for (const url of urls) {
      chrome.tabs.create({ url });
    }
  } else if (msg.action === "close") {
    const tabs = await chrome.tabs.query({});
    const filter = (msg.filter || "").toLowerCase();
    tabs
      .filter((t) => t.url && t.url.toLowerCase().includes(filter))
      .forEach((t) => chrome.tabs.remove(t.id));
  } else if (msg.action === "group") {
    const tabs = await chrome.tabs.query({});
    const filter = (msg.filter || "").toLowerCase();
    const matching = tabs.filter(
      (t) => t.url && t.url.toLowerCase().includes(filter)
    );
    if (matching.length > 0) {
      const groupId = await chrome.tabs.group({
        tabIds: matching.map((t) => t.id),
      });
      chrome.tabGroups.update(groupId, {
        title: msg.filter,
        collapsed: false,
      });
    }
  } else if (msg.action === "save_session") {
    const tabs = await chrome.tabs.query({});
    const sessionTabs = tabs
      .filter((t) => t.url && !t.url.startsWith("chrome://"))
      .map((t) => ({ url: t.url, title: t.title }));
    sendObservation({
      event: "session_save",
      tabs: sessionTabs,
      timestamp: Date.now(),
    });
  }
}

// ── Periodic heartbeat (every 5 min) ─────────────────────────────────

setInterval(async () => {
  try {
    const tabs = await chrome.tabs.query({});
    const activeTabs = tabs
      .filter((t) => t.url && !t.url.startsWith("chrome://"))
      .map((t) => ({ url: t.url, title: t.title }));

    sendObservation({
      event: "heartbeat",
      active_tabs: activeTabs,
      tab_count: activeTabs.length,
      timestamp: Date.now(),
    });
  } catch (e) {
    // Ignore
  }
}, 5 * 60 * 1000);

// Initialize connection
connect();
