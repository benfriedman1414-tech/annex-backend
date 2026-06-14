# Running Annex automatically

The backend has to run somewhere with internet access to your Airtable. (It can't run inside the Claude sandbox — that environment is firewalled off from Airtable.) Two good options, both prepared for you.

First, the one step only you can do (security — Claude can't type secret keys):

> **Add your Airtable token.** In the `annex-backend` folder, duplicate `.env.example`, rename the copy to `.env`, and paste your token after `AIRTABLE_API_KEY=`. Get a token at https://airtable.com/create/tokens (scopes: `data.records:read` + `data.records:write`, add the **Annex** base). The base ID is already filled in.

Then pick one:

---

## Option A — Run on your Mac, automatically (recommended for the beta)

Set-and-forget. Runs in the background, starts at login, restarts itself if it stops.

1. Double-click **`install-autostart.command`**.
   - If it opens in a text editor instead of running: right-click it → **Open** → **Open**. (macOS asks once because it's a script.)
2. That's it. It now checks Airtable continuously and writes a report for every new order.

- Activity log: `annex.log` in this folder.
- To stop it: double-click **`uninstall-autostart.command`**.
- Just want to run it once in a visible window? Double-click **`start.command`**.

Note: it runs while your Mac is on. If the Mac sleeps, processing pauses and resumes on wake — fine for a low-volume beta.

---

## Option B — Run in the cloud, always-on (independent of your Mac)

Use this when you want it up 24/7 regardless of your laptop. You create the account and click deploy (Claude can't create accounts or enter payment); all the config is ready.

**Render (example):**
1. Push this `annex-backend` folder to a GitHub repo.
2. On https://render.com → New → Blueprint → point it at the repo. It reads `render.yaml`.
3. In the dashboard, set `AIRTABLE_API_KEY` (and `RESEND_API_KEY` + `FROM_EMAIL` if auto-emailing). Deploy.

Railway / Fly.io work the same way — same start command (`node src/run.js --watch`) and the same env vars. A `Dockerfile` is included if the host prefers containers.

---

## Turning on auto-email (optional, either option)

Leave it off for the beta and you review/send each report yourself. To turn it on later: add a `RESEND_API_KEY` (from https://resend.com) and a verified `FROM_EMAIL` to `.env` (Option A) or the host's env vars (Option B). Reports then email to the homeowner automatically and the order is marked **Report sent**.
