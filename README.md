# 🔧 Repair Hub

A live, mobile-friendly tool for the phone & tablet repair team: look up
repair prices, check inventory, and log devices coming in for repair with
their status. Prices and inventory pull from Google Sheets — edit the sheet
and the app updates.

**Live app:** https://mikepilot123.github.io/pricechecker/

---

## Prices — how the team uses it

- Open the link on a phone, tablet, or the shop counter screen.
- Type any model — `13 Pro`, `S22 Ultra`, `A54`, `iPad` — and matching
  devices filter instantly.
- Tap **iPhone / iPad / Samsung** chips to browse a brand.
- Each card shows the cheapest repair (`from $…`); tap it to see the full
  breakdown (screen, battery, charging port, etc.).
- Leave the app open — it keeps the price list synced automatically.

Tip: on a phone, use **Share → Add to Home Screen** to install it like an app.
It opens full-screen and even loads offline (showing the last saved prices).

---

## How it stays in sync with the sheet

The app reads three tabs of the published Google Sheet as CSV:

| Tab | Sheet `gid` |
|-----|-------------|
| iPhones (incl. iPads) | `0` |
| Techno | `1021598529` |
| Samsung | `1256027568` |

- Prices load **on open**, **auto-sync in the background**, and when you
  reopen the tab.
- The front end connects to the Vercel WebSocket watcher at
  `wss://pricechecker-cyan.vercel.app/api/price-updates`. When that watcher
  detects sheet changes, it sends `price:update` and the app reloads
  immediately.
- To override the watcher on a shop device, use:

  ```js
  localStorage.setItem("rpc_price_update_ws", "wss://your-update-server.example");
  ```

  Set it to `"off"` to disable the socket. If the watcher is unavailable, the
  app falls back to a one-minute sync interval.
- A **"Updated just now"** timestamp shows how fresh the prices are.
- If the network is down, it shows the **last saved prices** with a notice.

> Google caches the published CSV, so a brand-new edit can take a minute or
> two to appear even after refreshing. That's normal.

### Updating prices

Just edit the Google Sheet. No code changes, no redeploy — new models,
new prices, and new repair columns all flow through automatically because
the app reads each table's structure dynamically. A tab may contain multiple
tables with different repair columns: for example, the iPhone table can use
`Incell Screen` while an iPad table in the same tab uses `Front Glass`.

### If the sheet link ever changes

If you re-publish or move the sheet, update the published URL and tab `gid`s
at the top of [`assets/app.js`](assets/app.js):

```js
const SHEET_BASE = "https://docs.google.com/.../pub";
const TABS = [
  { key: "apple",   gid: "0",          label: "iPhones" },
  { key: "techno",  gid: "1021598529", label: "Techno" },
  { key: "samsung", gid: "1256027568", label: "Samsung" },
];
```

---

## Check In — logging devices & repair status

The **Check In** tab guides the team through customer details first, then the
device and its issues, and finally payment. It also lets the team pick **one or
more issues** (tag-style multi-select, plus "Other" for anything not
listed), and track status through the repair pipeline: `Received →
Diagnosing → Waiting for Parts → In Progress → Repaired → Picked Up` (or
`Cancelled`). Every status change, device edit, or issue update is appended
to that ticket's **activity log** — visible on the card — so there's a full
timeline of what happened, not just the current state.

It captures Customer Name, Phone, Device, Issues, Status, and Notes. The
call button on each card dials the customer directly (`tel:` link) using
the phone number captured at check-in.

When a repair uses stock, staff can choose the exact inventory item during
check-in. The backend deducts one from that item in the inventory sheet when
the ticket is saved, and restores one if that ticket is deleted.

Open any ticket card to edit its client details, or use **Delete record** to
remove it after a confirmation prompt. Older tickets created before client
details were added do not contain a recoverable name or phone number; use
**Add client info** once on each of those records.

To reset the check-in list completely, use **Clear all** in the Check In toolbar and
confirm twice. It removes all ticket rows from the Sheet and dashboard, while
retaining the header row and the app's connection settings.

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
6. In the app, open the **Check In** tab — staff just enter the PIN once per
   device; it's remembered locally after that (never uploaded or committed).

If you already had an earlier version of `Code.gs` deployed, re-paste the
updated script over the old one and use **Manage deployments → Edit → New
version** — no need for a new URL. On its first request it preserves old
device records and adds the Customer Name, Phone, and History columns. This
deployment step is required before deleting records from the app.

The PIN is the only access control on this endpoint — anyone with it can
read every logged ticket (including customer name/phone) or write new ones.
Keep it private, and if it ever leaks, rotate it: change `PIN` in the
script, redeploy (same deployment, "Manage deployments → Edit → New
version"), and re-enter the new PIN on each device.

---

## Inventory

The **Inventory** tab reads the shop inventory spreadsheet tab:

```txt
https://docs.google.com/spreadsheets/d/1CtKYaNkcrlU1-76NvIQUK31V0OAEhwNZHkzWZOUDZVA/edit?gid=85811363
```

It parses the current section layout (`SCREENS`, `BATTERIES`, and `TOOLS`)
and shows device/item, quality, quantity, and notes. The app reads inventory
publicly through `/api/inventory`.

To let the backend write stock deductions/restocks back to the sheet, configure
these Vercel environment variables and share the spreadsheet with the service
account email:

```txt
GOOGLE_SERVICE_ACCOUNT_EMAIL
GOOGLE_PRIVATE_KEY
INVENTORY_SHEET_ID=1CtKYaNkcrlU1-76NvIQUK31V0OAEhwNZHkzWZOUDZVA
INVENTORY_SHEET_GID=85811363
```

If write credentials are not configured, the Inventory tab can still load, but
ticket saves with a selected stock item will fail with a setup message.

---

## Tech

Plain HTML/CSS/JS — **no build step, no dependencies**. Just static files
served by GitHub Pages. Includes a PWA manifest + service worker so it can be
installed to a home screen and opened offline.

```
index.html                 # markup (Prices + Check In views)
assets/style.css           # styling (mobile-first, dark theme)
assets/app.js              # CSV fetch + parse + search/filter UI (Prices)
assets/inventory.js        # Inventory tab UI and stock list loader
assets/intake.js           # device check-in UI (talks to Apps Script backend)
api/inventory.js           # Vercel API for inventory reads
api/price-updates.js       # Vercel WebSocket watcher for price sheet changes
apps-script/Code.gs         # Apps Script backend for the check-in sheet
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
