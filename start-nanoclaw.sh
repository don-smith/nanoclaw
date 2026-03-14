#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /Users/don/nanoclaw-sandbox-3936/nanoclaw.pid)

set -euo pipefail

cd "/Users/don/nanoclaw-sandbox-3936"

# Stop existing instance if running
if [ -f "/Users/don/nanoclaw-sandbox-3936/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/Users/don/nanoclaw-sandbox-3936/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/home/agent/.nvm/versions/node/v22.22.1/bin/node" "/Users/don/nanoclaw-sandbox-3936/dist/index.js" \
  >> "/Users/don/nanoclaw-sandbox-3936/logs/nanoclaw.log" \
  2>> "/Users/don/nanoclaw-sandbox-3936/logs/nanoclaw.error.log" &

echo $! > "/Users/don/nanoclaw-sandbox-3936/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /Users/don/nanoclaw-sandbox-3936/logs/nanoclaw.log"
