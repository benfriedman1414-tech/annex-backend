# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Annex is the backend engine for an ADU (Accessory Dwelling Unit) plan pre-check service. It reads homeowner "orders" from Airtable, checks each order's measurements against a table of cited zoning rules (also in Airtable), produces a self-contained HTML report flagging compliance problems, optionally emails it, and marks the order done so it isn't processed twice.

```
Softr /start form ──▶ Airtable "Orders" ──▶ THIS backend ──▶ cited HTML report ──▶ customer
                                                │
                                        Airtable "Rules" (the cited rules, edited live in the base)
```

## Commands

```bash
node src/run.js            # process every pending order once, then exit  (npm start)
node src/run.js --watch    # poll Airtable every POLL_SECONDS and process new orders forever  (npm run watch)
node test/selftest.js      # offline engine test + writes reports/SAMPLE-report.html  (npm test)
```

- **No build, no lint, no `npm install`.** The project is **zero-dependency** ESM (`"type": "module"`) on Node 18+ — it uses only `node:` builtins and global `fetch`. There is nothing to install.
- **`test/selftest.js` is a single monolithic script**, not a test framework — it runs all assertions in sequence and exits non-zero if any fail. There is no way to run "one test"; edit the file to narrow what it checks. It hits no network (fixture rules + sample orders are inline), so it's the fast way to validate engine changes.
- Requires outbound network access to `api.airtable.com` (and `api.resend.com` if emailing). Per `AUTOMATION.md` the backend is meant to run on the user's Mac (via `install-autostart.command` → launchd label `com.annex.precheck`) or as a cloud worker (`render.yaml` / `Dockerfile`), start command `node src/run.js --watch`.

## Architecture

`src/run.js` is the orchestrator; everything else is a single-purpose module it calls in this pipeline:

`fetchPendingOrders`/`fetchRules` (**airtable.js**) → `normalizeOrder` (**parse.js**) → `evaluateOrder` (**rules.js**) → `buildReportHtml`/`buildEmailText` (**report.js**) → `sendReportEmail` (**email.js**) → `updateOrderStatus` (**airtable.js**).

Three design decisions drive most of the code and are not obvious from any single file:

**1. Rules are data, not code.** The 34+ rules live in the Airtable **Rules** table and are fetched live on every run, so changing a requirement/threshold/citation means editing Airtable — *not* this repo. `rules.js` is a generic engine that interprets whatever rows come back. To change *what the rules are*, do not touch code.

**2. The engine never produces a false pass — it has four outcomes** (`STATUS` in `rules.js`): `PASS`/`FLAG` only for rules it can numerically self-check, `REVIEW` for inherently contextual rules, and `NEEDS INPUT` when the order is missing the number a numeric rule needs. The flow:
   - `mapMetric()` keyword-matches a rule's `requirement` text to one order metric (`sideSetbackFt`, `heightFt`, `aduSqft`, …) via `METRIC_MATCHERS`. The `ALWAYS_REVIEW` keyword list short-circuits contextual requirements (lot coverage, owner-occupancy, fire/sprinkler, fees, design review, …) to `REVIEW` regardless.
   - `parseThreshold()` turns a free-text threshold (`">= 4 ft"`, `"<= 1,200 sq ft"`, `"850 sq ft must be allowed"`) into `{op, value, unit}`. Compound thresholds containing `/` are deliberately treated as non-numeric → `REVIEW`. There is a special `isProtectedSize` path for state-guaranteed minimum sizes.
   - `ruleApplies()` filters rules by ADU type (`appliesTo`) and bedroom scope before evaluation.

**3. Both the Airtable schema and the order data are read defensively, because the live Softr form's field names vary.**
   - `airtable.js` `pick(fields, [...])` tries several possible column names per field (e.g. citation may be `Code citation`, `Citation`, `Code`, or `Source`). When adding a field, extend the candidate list rather than assuming one name.
   - `parse.js` `normalizeOrder()` **prefers structured Order columns but falls back to regex-parsing the free-text `Concerns` box** (the current beta form dumps everything there). So `feet()`/`grab()` extract things like `15'6"` → `15.5` and `side setback 3 ft` from prose.

### Adding a new auto-checked metric (the main cross-file change)

This is the one workflow that spans files. To make a new measurement numerically checkable you must touch **both**:
1. `parse.js` — extract the value into `order.<metric>` (structured field + free-text `grab()` fallback).
2. `rules.js` — add it to `METRIC_MATCHERS` (text→metric), `METRIC_LABELS`, and `fmtValue()` if it needs special formatting.

Then add an assertion in `test/selftest.js`. Missing either side silently downgrades the rule to `REVIEW`/`NEEDS INPUT` instead of erroring.

## Order lifecycle / idempotency

`fetchPendingOrders()` skips orders whose `Status` is `ORDERS_DONE_STATUS` ("Report ready") or `ORDERS_SENT_STATUS` ("Report sent"). If `ORDERS_NEW_STATUS` is set, only that status is processed; otherwise anything not-yet-done is fair game. After a report is written, `updateOrderStatus()` sets the order to `Report ready`, or `Report sent` when an email actually went out — this status writeback is what prevents reprocessing, so preserve it.

## Configuration

`src/config.js` is a zero-dependency `.env` loader. Important: it **does not overwrite variables already present in the real environment** — so on a cloud host the dashboard env vars win over any committed `.env`. Key vars (see `.env.example`): `AIRTABLE_API_KEY` (required), `AIRTABLE_BASE_ID`/`AIRTABLE_RULES_TABLE`/`AIRTABLE_ORDERS_TABLE`, the three `ORDERS_*_STATUS` values, `POLL_SECONDS`, and for optional email `RESEND_API_KEY` + `FROM_EMAIL` (must be a Resend-verified sender domain). Email sending is gated entirely on `RESEND_API_KEY` being non-empty (`email.js` `emailEnabled()`); with it blank, reports are still generated, saved, and status-updated — just not emailed.
