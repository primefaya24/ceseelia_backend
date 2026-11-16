#!/bin/bash
# Manual update: build the API image on the server from the copied node/dist (after
# ./scp-fs.sh build) and restart node. The usual path is the GitHub deploy (deploy-image.sh).
set -euo pipefail
cd "$(dirname "$0")"
echo "[⏳] Starting Node app update..."

# A local build, not the ECR image the GitHub deploy may have left in .env.
export NODE_IMAGE=ceseelia-node
docker compose build node
docker compose up -d --no-deps node
echo "NODE_IMAGE=$NODE_IMAGE" > .env

# Clean up unused layers to save disk space
docker image prune -f

echo "[✅] Update complete."
