#!/bin/bash
# Build the API image here and copy it to the prod server (when the server is too small to build).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
source ./server.conf
docker build -t ceseelia-node:latest ./node
docker save ceseelia-node:latest -o node-image.tar
scp -i "$SERVER_KEY" node-image.tar "$SERVER_USER@$SERVER_HOST:/home/ec2-user/"
