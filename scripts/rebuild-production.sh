#!/bin/bash
# Rebuild production server for remote access (ccpilot.swifttools.eu)
# Builds in a temp directory to avoid corrupting dev server's .next cache
# Usage: ./scripts/rebuild-production.sh

set -e

# Force production environment — prevent dev server's NODE_ENV from leaking in
# (next build fails on /_global-error prerendering without this)
export NODE_ENV=production

PROJECT_DIR="/Users/party/working/CodePilot"
BUILD_DIR="/tmp/codepilot-build"
STANDALONE_DIR="$PROJECT_DIR/.next/standalone"

echo "Preparing build directory..."
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Copy source + node_modules (exclude .next, .git)
rsync -a --exclude='.next' --exclude='.git' \
    --exclude='.codepilot-uploads' --exclude='.worktrees' \
    "$PROJECT_DIR/" "$BUILD_DIR/"

echo "Building production..."
cd "$BUILD_DIR"
npx next build

echo "Deploying standalone output..."
rm -rf "$STANDALONE_DIR"
cp -r "$BUILD_DIR/.next/standalone" "$STANDALONE_DIR"
cp -r "$BUILD_DIR/.next/static" "$STANDALONE_DIR/.next/static"
cp -r "$PROJECT_DIR/public" "$STANDALONE_DIR/public" 2>/dev/null || true

echo "Cleaning up build directory..."
rm -rf "$BUILD_DIR"

echo "Restarting production server..."

# Kill old process explicitly (launchctl kickstart -k is unreliable)
OLD_PID=$(/usr/sbin/lsof -ti :4001 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
    echo "Killing old server (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    # Wait for old process to die
    for i in $(seq 1 10); do
        if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
        sleep 1
    done
fi

# launchd KeepAlive will auto-restart with new binary
# Wait for new process to come up
for i in $(seq 1 15); do
    NEW_PID=$(/usr/sbin/lsof -ti :4001 2>/dev/null || true)
    if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ]; then
        echo "Done! Production server running on port 4001 (PID $NEW_PID)."
        exit 0
    fi
    sleep 1
done

echo "ERROR: Production server failed to start within 15 seconds"
exit 1
