# 🔧 Repair Hub

A live, mobile-friendly tool for the phone & tablet repair team: look up
repair prices, and log devices coming in for repair with their status.
Both pull from Google Sheets — edit the sheet and the app updates.

**Live app:** https://mikepilot123.github.io/pricechecker/

---

## Prices — how the team uses it

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

## Intake — logging devices & repair status

The **Intake** tab lets the team log a customer's device + issue and track
status through the repair pipeline: `Received → Diagnosing → Waiting for
Parts → In Progress → Repaired → Picked Up` (or `Cancelled`). It captures
Customer Name, Phone, Device, Issue (preset dropdown + "Other"), Status, and
Notes.

Data is stored in a separate, dedicated Google Sheet ("JQ Reapirs"), written
to only through a PIN-gated Apps Script — never read as a public CSV.

**Privacy — this sheet now holds customer PII (name + phone).** It must
**not** be published to the web or link-shared. Verify both are off:
**File → Share → Publish to web** (should be off/unpublished) and the
**Share** button (should be restricted, not "Anyone with the link"). The
app never needs it published — it only ever talks to the Apps Script
endpoint below.

### One-time setup (per team manager)

A static site can't write to Google Sheets directly, so writes go through a
small Google Apps Script "web app" that the sheet owner deploys once. The
script's URL is already wired into [`assets/intake.js`](assets/intake.js) —
only the PIN is entered by staff.

1. Open the JQ Reapirs spreadsheet → **Extensions → Apps Script**.
2. Paste in the contents of [`apps-script/Code.gs`](apps-script/Code.gs).
3. Change the `PIN` value at the top to a private PIN for your team.
4. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the resulting `.../exec` URL and update the `SCRIPT_URL` constant
   near the top of [`assets/intake.js`](assets/intake.js) (only needed if
   you redeploy to a new URL — the current one is already set).
6. In the app, open the **Intake** tab — staff just enter the PIN once per
   device; it's remembered locally after that (never uploaded or committed).

The PIN is the only access control on this endpoint — anyone with it can
read every logged ticket (including customer name/phone) or write new ones.
Keep it private, and if it ever leaks, rotate it: change `PIN` in the
script, redeploy (same deployment, "Manage deployments → Edit → New
version"), and re-enter the new PIN on each device.

---

## Tech

Plain HTML/CSS/JS — **no build step, no dependencies**. Just static files
served by GitHub Pages. Includes a PWA manifest + service worker so it can be
installed to a home screen and opened offline.

```
index.html                 # markup (Prices + Intake views)
assets/style.css           # styling (mobile-first, dark theme)
assets/app.js              # CSV fetch + parse + search/filter UI (Prices)
assets/intake.js           # device intake UI (talks to Apps Script backend)
apps-script/Code.gs         # Apps Script backend for the Intake sheet
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
