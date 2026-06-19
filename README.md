# 🔧 Repair Price Checker

A live, mobile-friendly price lookup tool for the phone & tablet repair team.
Type a model, get the price. Data comes **straight from the shop's Google
Sheet pricelist** — edit the sheet and the app updates automatically.

**Live app:** https://mikepilot123.github.io/pricechecker/

---

## How the team uses it

- Open the link on a phone, tablet, or the shop counter screen.
- Type any model — `13 Pro`, `S22 Ultra`, `A54`, `iPad` — and matching
  devices filter instantly.
- Tap **iPhone / iPad / Samsung** chips to browse a brand.
- Each card shows the cheapest repair (`from $…`); tap it to see the full
  breakdown (screen, battery, charging port, etc.).
- Tap **Refresh** any time, or just reopen — it pulls the latest prices.

Tip: on a phone, use **Share → Add to Home Screen** to install it like an app.
It opens full-screen and even loads offline (showing the last saved prices).

---

## How it stays in sync with the sheet

The app reads two tabs of the published Google Sheet as CSV:

| Tab | Sheet `gid` |
|-----|-------------|
| iPhones (incl. iPads) | `0` |
| Samsung | `1256027568` |

- Prices load **on open**, **auto-refresh every 5 minutes**, on **manual
  refresh**, and when you reopen the tab.
- A **"Updated just now"** timestamp shows how fresh the prices are.
- If the network is down, it shows the **last saved prices** with a notice.

> Google caches the published CSV, so a brand-new edit can take a minute or
> two to appear even after refreshing. That's normal.

### Updating prices

Just edit the Google Sheet. No code changes, no redeploy — new models,
new prices, and new repair columns all flow through automatically because
the app reads the sheet's structure dynamically.

### If the sheet link ever changes

If you re-publish or move the sheet, update the published URL and tab `gid`s
at the top of [`assets/app.js`](assets/app.js):

```js
const SHEET_BASE = "https://docs.google.com/.../pub";
const TABS = [
  { key: "apple",   gid: "0",          label: "iPhones" },
  { key: "samsung", gid: "1256027568", label: "Samsung" },
];
```

---

## Tech

Plain HTML/CSS/JS — **no build step, no dependencies**. Just static files
served by GitHub Pages. Includes a PWA manifest + service worker so it can be
installed to a home screen and opened offline.

```
index.html                 # markup
assets/style.css           # styling (mobile-first, dark theme)
assets/app.js              # CSV fetch + parse + search/filter UI
manifest.webmanifest       # installable PWA
sw.js                      # offline app shell
```

## Running locally

It's static, so any local server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

---

*Prices are in TTD. This tool is for internal team use.*
