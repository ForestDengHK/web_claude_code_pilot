#!/bin/bash
# Rebuild production server for remote access (ccpilot.swifttools.eu)
# Usage: ./scripts/rebuild-production.sh

set -e

echo "Building production..."
npx next build

echo "Copying static assets..."
cp -r .next/static .next/standalone/.next/static
cp -r public .next/standalone/public 2>/dev/null || true

echo "Restarting production server..."
launchctl kickstart -k gui/$(id -u)/com.codepilot.production

sleep 2

# Verify
if /usr/sbin/lsof -i :4001 -P | grep -q LISTEN; then
    echo "Production server is running on port 4001"
else
    echo "ERROR: Production server failed to start"
    exit 1
fi

echo "Done! Remote access updated."
