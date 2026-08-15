# Repair Hub browser extension

A thin wrapper, not a separate app: clicking the toolbar icon opens the live
Repair Hub (`https://mikepilot123.github.io/pricechecker/`) in Chrome's side
panel, docked next to whatever site you're on — Facebook Messenger, WhatsApp
Web, email, anywhere a customer conversation happens. There's nothing bundled
or cached here; it always shows the live site, so a price change or a new
feature on the site itself needs no extension update.

## Install (unpacked, not on the Chrome Web Store)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the "Repair Hub" icon to the toolbar (puzzle-piece icon → pin).

Click the toolbar icon on any site to open or close the side panel. The app
inside behaves exactly like the full site — same PIN-gated Settings, same
login state (it shares `localStorage`/cookies with the regular
`mikepilot123.github.io` tab, since it's the same origin).

## Requirements

Chrome 114+ (or another Chromium browser with the `sidePanel` API — Edge
116+). Firefox doesn't support this API; a Firefox version would need a
separate `sidebar_action`-based manifest.

## Updating

Nothing to update, normally — this only points at the live URL. If the site's
URL ever changes, update the `src` in `sidepanel.html`. If you re-brand the
icon, regenerate `icons/icon{16,32,48,128}.png` from
`assets/branding/icon-512.png`.

## Publishing to the Chrome Web Store (optional)

Not done here — that requires a $5 one-time developer account, store
listing copy/screenshots, and their review process. Loading unpacked (above)
is enough for internal shop use; every device that wants it just repeats
those four steps once.
