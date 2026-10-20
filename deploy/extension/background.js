// MirrorLab — Chrome/Edge Manifest V3 Background Worker
// CORS ve iframe çerçeve kısıtlamalarını dinamik kurallarla kaldırır.
chrome.runtime.onInstalled.addListener(async () => {
  const RULE_ID = 1;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [RULE_ID],
      addRules: [
        {
          id: RULE_ID,
          priority: 1,
          action: {
            type: "modifyHeaders",
            responseHeaders: [
              { header: "access-control-allow-origin", operation: "set", value: "*" },
              { header: "access-control-allow-methods", operation: "set", value: "GET, POST, PUT, DELETE, OPTIONS" },
              { header: "access-control-allow-headers", operation: "set", value: "*" },
              { header: "content-security-policy", operation: "remove" },
              { header: "x-frame-options", operation: "remove" }
            ]
          },
          condition: {
            urlFilter: "*",
            resourceTypes: ["xmlhttprequest", "sub_frame", "image", "media", "script", "stylesheet", "other"]
          }
        }
      ]
    });
    console.log("[MirrorLab Extension] Sıfır-backend CORS bypass kuralları etkinleştirildi.");
  } catch (err) {
    console.error("[MirrorLab Extension] Kural yükleme hatası:", err);
  }
});

// Eklenti simgesine tıklandığında tam sekmede MirrorLab'i açabilme
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
});
