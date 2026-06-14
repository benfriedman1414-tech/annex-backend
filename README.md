# Annex backend

The engine behind Annex. It connects to your existing stack and runs the whole pipeline:

```
Softr /start form  ──▶  Airtable "Orders"  ──▶  THIS  ──▶  cited pass/flag report  ──▶  customer
                                                  │
                                          Airtable "Rules" (your 34 cited rules)
```

For every new order it: reads the homeowner's numbers, checks them against your **Rules** table (pulled live from Airtable, so the rules stay editable in the base — no code changes), generates a report that matches your site's design, saves it, optionally emails it, and marks the order done in Airtable.

It has **zero dependencies** — just Node 18+ (you have v22). Nothing to `npm install`.

---

## 1. One-time setup (≈2 minutes)

1. **Get an Airtable token** → https://airtable.com/create/tokens
   - Scopes: `data.records:read` and `data.records:write`
   - Access: add the **Annex** base
2. Copy `.env.example` to `.env` and paste the token after `AIRTABLE_API_KEY=`.
   (The base ID and table names are already filled in.)
3. *(Optional)* To auto-email reports, add a `RESEND_API_KEY` from https://resend.com and set `FROM_EMAIL` to an address on a domain you've verified there. **Leave it blank to skip email** — reports are still generated and saved.

## 2. Run it

```bash
# process every pending order once
node src/run.js

# OR keep it running and auto-process new orders as they arrive
node src/run.js --watch
```

Generated reports land in `./reports/` as self-contained HTML (open in any browser; print → Save as PDF for a PDF). Each processed order's **Status** is set to `Report ready` (or `Report sent` if emailed), so it won't be processed twice.

## 3. The two delivery modes

- **Beta (recommended): you send.** Leave `RESEND_API_KEY` blank. The backend produces each report and sets the order's Status; you open the report, eyeball it, and email it yourself. Keeps a human check on the first real customers.
- **Hands-off: auto-email.** Add the Resend key. The report is emailed to the homeowner automatically and the order is marked `Report sent`.

## 4. Editing the rules

Edit the **Rules** table in Airtable directly — add, remove, or change a requirement, threshold, citation, or fix. The engine reads them live on every run, so no code changes are needed. Numeric thresholds like `>= 4 ft`, `<= 16 ft`, `<= 1200 sq ft` are auto-checked; contextual rules (e.g. "Per underlying zone") are surfaced as **REVIEW** so you apply judgment. Missing numbers come back as **NEEDS INPUT** rather than a false pass.

## 5. Test without touching Airtable

```bash
node test/selftest.js
```

Runs the engine on a sample order (structured **and** free-text), checks the verdicts, and writes `reports/SAMPLE-report.html` so you can see the report design.

---

## How the order's numbers are read

The engine prefers the structured Orders columns (`Lot size sqft`, `ADU sqft`, `Bedrooms`, `Height ft`, `Rear setback ft`, `Side setback ft`, etc.). If those are empty — which is the case for the current beta form, where everything goes in the free-text **Concerns** box — it parses the numbers out of that text (e.g. `side setback 3 ft`, `812 sq ft`, `15'6"`). So it works today, and gets even more reliable if you later add the granular fields to the form.

## Files

| File | What it does |
|------|--------------|
| `src/run.js` | Main runner (once or `--watch`) |
| `src/airtable.js` | Reads Rules + Orders, writes Status |
| `src/parse.js` | Normalizes an order (structured + free-text) |
| `src/rules.js` | The rules engine + threshold parser |
| `src/report.js` | Builds the dark/emerald HTML report |
| `src/email.js` | Optional Resend delivery |
| `test/selftest.js` | Offline test + sample report |

## Running it automatically, always-on

See **`AUTOMATION.md`** — it's set up two ways for you:
- **On your Mac:** double-click `install-autostart.command` and it runs in the background, at login, forever.
- **In the cloud:** `Dockerfile` + `render.yaml` are ready for a one-deploy worker on Render / Railway / Fly.io.

Both just need your Airtable token in `.env` first (the one step only you can do).
