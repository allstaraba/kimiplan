#!/bin/bash
# All Star ABA — one-command launcher (Docker)
# Usage:
#   ./start.sh        # run in foreground (see logs, Ctrl+C to stop)
#   ./start.sh -d     # run in background (then open http://localhost:3000)
#   ./start.sh stop   # stop the background container

cd "$(dirname "$0")"

if [ "$1" == "stop" ]; then
  echo "Stopping All Star ABA…"
  docker compose down
  exit 0
fi

if [ "$1" == "-d" ] || [ "$1" == "--detach" ]; then
  echo "Starting All Star ABA in the background…"
  docker compose up -d --build
  echo ""
  echo "✅ App is running at http://localhost:3000"
  echo "   Stop it anytime with: ./start.sh stop"
  exit 0
fi

echo "Starting All Star ABA (foreground mode)…"
echo "Press Ctrl+C to stop"
echo ""
docker compose up --build
