#!/bin/bash
# Double-click me. I'll ask for your Airtable token, test it, and set the
# Annex backend to run automatically in the background (at login, forever).
set -e
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"
clear
echo "──────────────────────────────────────────────"
echo "   Annex backend — automatic setup"
echo "──────────────────────────────────────────────"
echo

# 1) Make sure Node is installed
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$p" ] && NODE="$p" && break; done
fi
if [ -z "$NODE" ]; then
  echo "✗ Node isn't installed yet — the backend needs it."
  echo "  I'll open the download page. Install it (Continue → Agree → Install),"
  echo "  then double-click this file again."
  open "https://nodejs.org/en/download" 2>/dev/null || true
  read -r -p "Press enter to close..."
  exit 1
fi
echo "✓ Node found ($("$NODE" --version))"

# 2) Get the Airtable token and write .env
if [ -f .env ] && grep -q '^AIRTABLE_API_KEY=..*' .env; then
  echo "✓ Airtable token already saved"
else
  echo
  echo "Paste your Airtable token, then press enter."
  echo "(Get one at https://airtable.com/create/tokens — it starts with 'pat'.)"
  echo "It is stored only here on your Mac, in this folder."
  echo
  read -r -p "Airtable token: " TOKEN
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
  if [ -z "$TOKEN" ]; then echo "Nothing entered — re-run when you have the token."; read -r -p "Press enter to close..."; exit 1; fi
  cat > .env <<EOF
AIRTABLE_API_KEY=$TOKEN
AIRTABLE_BASE_ID=appaa8u2MVRT4obQP
AIRTABLE_RULES_TABLE=Rules
AIRTABLE_ORDERS_TABLE=Orders
ORDERS_DONE_STATUS=Report ready
ORDERS_SENT_STATUS=Report sent
REPORTS_DIR=./reports
POLL_SECONDS=120
EOF
  echo "✓ Token saved"
fi

# 3) Test the connection before installing
echo
echo "Testing the Airtable connection..."
if "$NODE" -e "import('./src/airtable.js').then(m=>m.fetchRules()).then(r=>{console.log('  ✓ Connected — '+r.length+' rules loaded from Airtable');process.exit(0)}).catch(e=>{console.error('  ✗ '+e.message);process.exit(2)})"; then
  :
else
  echo "  The token didn't connect. Check it has the Annex base added and both"
  echo "  data.records:read and data.records:write scopes, then re-run me."
  echo "  (Installing anyway — it'll start working the moment the token is right.)"
fi

# 4) Install the background service (launchd)
LABEL="com.annex.precheck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$APP_DIR/src/run.js</string>
    <string>--watch</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/annex.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/annex.log</string>
</dict></plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo
echo "✓ All set. Annex now runs automatically in the background and starts at login."
echo "    Reports →  $APP_DIR/reports"
echo "    Log     →  $APP_DIR/annex.log"
echo "    Stop    →  double-click uninstall-autostart.command"
echo
read -r -p "Press enter to close..."
