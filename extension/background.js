// Clicking the toolbar icon opens the side panel instead of a popup — a
// popup closes the moment focus leaves it (e.g. clicking into the page to
// copy a customer's number), which defeats the point of a quick-lookup tool
// meant to stay open alongside whatever else is on screen.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("Repair Hub: couldn't set side panel behavior", err));
