# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Annex is the backend engine for an ADU (Accessory Dwelling Unit) plan pre-check service. It reads homeowner "orders" from Airtable, checks each order's measurements against a table of cited zoning rules (also in Airtable), produces a self-contained HTML report flagging compliance problems, optionally emails it, and marks the order done so it isn't processed twice.

```
Softr /precheck form ──▶ Airtable "Orders" ──▶ THIS backend ──▶ free teaser summary ──▶ paid unlock ──▶ cited HTML report
                                                │                                (Stripe verify)
                                        Airtable "Rules" (the cited rules, edited live in the base)
```

## Freemium flow (two services from this repo)

- **`node src/run.js --watch`** — the poll WORKER (Render background worker): legacy orders, teaser emails to abandoners, Stripe session sweep, stale-generate reclaim.
- **`node src/server.js`** — the public API (Render web service `annex-api`, free tier): `GET /api/summary?token=` (on-demand engine run + vision; returns teaser COUNTS + flag categories only — never citations/thresholds/fixes) and `POST /api/unlock` (verifies a Stripe Checkout session via a RESTRICTED read-only key, marks Paid, generates + emails the full report in-process).
- **Discriminator:** orders WITH a "Client token" field are freemium (full report gated on `Paid`); orders WITHOUT are legacy (processed immediately). The Softr form fills the hidden token field from the `?token` URL parameter, which the page footer JS plants via `history.replaceState`.
- **Status lifecycle (freemium):** New → `Summary ready` (page saw the teaser) → `Summary sent` (teaser email to abandoner) → `Paid` → `Generating report` (API in-flight) → `Report ready/sent`. `decideFreemiumStep()` in summary.js is the pure decision function; the teaser builder is `buildTeaser()` (leak-tested in selftest TEST 7).
- **City-rules research (`src/cityrules.js`):** city ordinances bind inside city limits (county rules only govern unincorporated land), so the worker researches each NEW city seen in an order — one web-search Fable-5 call (Opus fallback) drafts rule rows into the Airtable Rules table with `Jurisdiction="City of X"` and `Verification="Pending"`, plus a `Marker` row (research date + sources) so research runs once per city ever. A SECOND, independent verifier pass (`autoVerifyCityRules`) then fetches each rule's cited source page and adversarially confirms the exact threshold; only source-confirmed high-confidence, non-preempted rules are auto-flipped to `Verified` (policy: `autoVerifyDecision`, selftest TEST 9). **Pending/held rows can only ever surface as REVIEW** — fully automatic, no human step; the owner can still overrule via the Verification column. `rules.js` also clamps preempted local standards (side/rear setback demands > 4 ft, height allowance < 16 ft → REVIEW, "state law controls") and skips `Superseded`/`Marker` rows. A ~90-day refresh re-researches covered cities and ALERTS on drift (never auto-rewrites). Capped at 2 new cities per poll; the watch loop has a re-entrancy guard because research takes minutes.
- **Shared pipeline:** `src/pipeline.js` (`generateAndSendReport`, `readPhotoIfNeeded`) is used by BOTH entry points — change report behavior there, not in run.js/server.js.

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

## Photo intake (vision) — `src/vision.js`

A front-end to the existing pipeline that does **not** touch the rules engine. For an order with a `Plan photo` attachment and an unread status, `run.js` calls `extractFromPhoto()` (Anthropic Messages API over raw `fetch` — no SDK, matching `airtable.js`/`email.js`), which **forces a single strict tool call** (`record_plan_dimensions`) so the model returns schema-validated JSON of the dimensions (value + confidence + note per field, plus a `needsConfirmation` list). `buildExtractionNotes()` renders that into the `Extraction notes` column, **leading with a normalized sentence in the exact phrasings `parse.js` already recognizes** — so the engine reads the photo's numbers through the existing free-text path, with no dependency on structured columns existing. Photo orders process **fully automatically**: `New → Reading photo →` engine runs in the same pass `→ Report ready/sent` — no human hold. Safety comes from the confidence gate in `vision.js` (`usable()`): only high/medium-confidence reads that the model did NOT flag in `needsConfirmation` are placed in the machine-parseable first line of the extraction notes; unclear reads are excluded (and printed WITHOUT their numeral, so the parser can't re-grab them) and surface as NEEDS INPUT rows in the report. Two exceptions still hold at `Needs confirmation`: an illegible image (`readable:false`, owner alerted to follow up) and keyless mode (no `ANTHROPIC_API_KEY` — queued for manual reading). The `Confirmed` status still works for releasing held orders.

## Configuration

`src/config.js` is a zero-dependency `.env` loader. Important: it **does not overwrite variables already present in the real environment** — so on a cloud host the dashboard env vars win over any committed `.env`. Key vars (see `.env.example`): `AIRTABLE_API_KEY` (required), `AIRTABLE_BASE_ID`/`AIRTABLE_RULES_TABLE`/`AIRTABLE_ORDERS_TABLE`, the three `ORDERS_*_STATUS` values, `POLL_SECONDS`, and for optional email `RESEND_API_KEY` + `FROM_EMAIL` (must be a Resend-verified sender domain). Email sending is gated entirely on `RESEND_API_KEY` being non-empty (`email.js` `emailEnabled()`); with it blank, reports are still generated, saved, and status-updated — just not emailed.
