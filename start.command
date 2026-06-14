#!/bin/bash
# Double-click to start the Annex backend right now. Leave the window open.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || exit 1
NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -x "$p" ] && NODE="$p" && break; done
fi
if [ -z "$NODE" ]; then echo "Node 18+ not found. Install it from https://nodejs.org then try again."; read -r -p "Press enter to close..."; exit 1; fi
if [ ! -f ".env" ]; then echo "No .env yet. Copy .env.example to .env and add your Airtable token first."; read -r -p "Press enter to close..."; exit 1; fi
echo "Annex backend is running and watching for new orders. Keep this window open. Press Ctrl+C to stop."
"$NODE" src/run.js --watch
