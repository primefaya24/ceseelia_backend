#!/bin/bash
# Copy the project to the prod API server (settings in server.conf).
#   ./scp-fs.sh build    # build node/dist first, then copy
#   ./scp-fs.sh          # copy as is
# Then on the server: ./node-update.sh (or ./system-init.sh the first time).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./server.conf

if [ "${1:-}" = "build" ]; then
  echo "Building the Node.js project..."
  (cd node && npm run build) || { echo "Build failed"; exit 1; }
else
  echo "Skipping build step"
fi

# Never copied: dependencies, git, local env files, and the server's own certificates and logs.
rsync -avz \
  --exclude 'node_modules' --exclude '.git' --exclude '.idea' \
  --exclude 'node/.env' --exclude 'certbot/' --exclude '*.log' --exclude 'node-image.tar' \
  -e "ssh -i $SERVER_KEY" \
  . "$SERVER_USER@$SERVER_HOST:$SERVER_DIR/"
