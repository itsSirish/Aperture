// Cortex Content Script — DOM Observation (lightweight)
// Only extracts page metadata, does NOT scrape full page content

(function () {
  // Extract meaningful page metadata
  const metadata = {
    title: document.title,
    url: window.location.href,
    domain: window.location.hostname,
    // Extract meta description if available
    description:
      document.querySelector('meta[name="description"]')?.content || "",
    // Detect page type from common patterns
    pageType: detectPageType(),
    timestamp: Date.now(),
  };

  // Send to background script
  chrome.runtime.sendMessage({
    type: "page_metadata",
    data: metadata,
  });

  function detectPageType() {
    const url = window.location.href.toLowerCase();
    const hostname = window.location.hostname.toLowerCase();

    if (hostname.includes("github.com")) return "code";
    if (hostname.includes("stackoverflow.com")) return "reference";
    if (hostname.includes("docs.google.com")) return "document";
    if (hostname.includes("mail.google.com")) return "email";
    if (hostname.includes("calendar.google.com")) return "calendar";
    if (hostname.includes("slack.com")) return "communication";
    if (hostname.includes("notion.so")) return "notes";
    if (hostname.includes("figma.com")) return "design";
    if (hostname.includes("arxiv.org")) return "research";
    if (hostname.includes("medium.com")) return "article";
    if (hostname.includes("youtube.com")) return "video";
    if (hostname.includes("spotify.com")) return "music";
    if (url.includes("/docs/") || url.includes("/documentation/"))
      return "documentation";
    return "web";
  }
})();
