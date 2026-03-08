const WS_KEY = "cortex_backend_ws";
const DEFAULT_WS = "ws://localhost:8080/ws";

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved URL
  chrome.storage.local.get(WS_KEY, (result) => {
    document.getElementById("backendUrl").value = result[WS_KEY] || DEFAULT_WS;
  });

  // Update tab count
  const tabs = await chrome.tabs.query({});
  const tracked = tabs.filter(
    (t) => t.url && !t.url.startsWith("chrome://")
  ).length;
  document.getElementById("tabCount").textContent = tracked;

  // Check connection status by fetching health endpoint
  const wsUrl = (
    await new Promise((r) =>
      chrome.storage.local.get(WS_KEY, (res) => r(res[WS_KEY] || DEFAULT_WS))
    )
  ).replace("ws://", "http://").replace("wss://", "https://").replace("/ws", "/health");

  try {
    const resp = await fetch(wsUrl);
    if (resp.ok) {
      document.getElementById("statusDot").classList.add("connected");
      document.getElementById("statusText").textContent = "Connected";

      // Fetch belief count
      const beliefsUrl = wsUrl.replace("/health", "/beliefs?limit=1");
      try {
        const bResp = await fetch(beliefsUrl);
        const beliefs = await bResp.json();
        document.getElementById("beliefCount").textContent = Array.isArray(beliefs) ? beliefs.length : "?";
      } catch {
        document.getElementById("beliefCount").textContent = "-";
      }
    }
  } catch {
    document.getElementById("statusText").textContent = "Disconnected";
  }

  // Save button
  document.getElementById("saveBtn").addEventListener("click", () => {
    const url = document.getElementById("backendUrl").value.trim();
    if (url) {
      chrome.storage.local.set({ [WS_KEY]: url }, () => {
        document.getElementById("saveBtn").textContent = "Saved!";
        setTimeout(() => {
          document.getElementById("saveBtn").textContent = "Save & Reconnect";
        }, 1500);
      });
    }
  });
});
