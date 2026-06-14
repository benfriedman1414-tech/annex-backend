#!/bin/bash
# Double-click to stop the Annex backend from running automatically.
PLIST="$HOME/Library/LaunchAgents/com.annex.precheck.plist"
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "✓ Auto-start removed. The Annex backend will no longer run in the background."
read -r -p "Press enter to close..."
