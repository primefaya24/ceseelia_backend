#!/bin/bash
# Open a shell on the prod API server (settings in server.conf).
source "$(dirname "${BASH_SOURCE[0]}")/server.conf"
chmod 400 "$SERVER_KEY"
exec ssh -i "$SERVER_KEY" "$SERVER_USER@$SERVER_HOST" "$@"
