#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"

echo "Starting MiniRaft..."
docker compose up --build "$@"

echo ""
echo "  App: http://localhost:4000"
echo ""
