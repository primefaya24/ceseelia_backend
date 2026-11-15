#!/bin/bash
# Renews the Let's Encrypt certificates and reloads nginx when any changed (launch item L.3 / S.17).
#
# Runs from cron twice a day (see system-init.sh). Works from wherever the project folder is:
# it uses the certbot folders next to this script, the same ones docker-compose.yml mounts.
# certbot only renews certificates within 30 days of expiry; the rest of the time it does nothing.
#
# Fixed 2026-11-14:
#   - the script wasn't executable in git (cron: "Permission denied"); cron now runs it with bash
#   - it mounted /home/ec2-user/primedine/... wherever the project really was, so certbot saw
#     empty folders and renewed nothing
#   - its --deploy-hook ran `docker compose` inside the certbot container, which has no docker,
#     so nginx never picked up a renewed certificate. The hook now only leaves a marker, and
#     this script reloads nginx from the host.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# cron has a minimal PATH; docker lives in /usr/bin or /usr/local/bin.
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

WEBROOT_PATH="$PROJECT_DIR/certbot/webroot"
SSL_PATH="$PROJECT_DIR/certbot/ssl"
MARKER="$SSL_PATH/.renewed"

echo "=== Renewal run started at $(date -u) in $PROJECT_DIR ==="

if [ ! -d "$SSL_PATH/live" ]; then
  echo "ERROR: no certificates in $SSL_PATH/live. Run ./generate-cert.sh api first." >&2
  exit 1
fi

rm -f "$MARKER"

docker run --rm \
  -v "$WEBROOT_PATH:/var/www/certbot" \
  -v "$SSL_PATH:/etc/letsencrypt" \
  certbot/certbot:v5.10.0 renew --webroot -w /var/www/certbot --non-interactive \
  --deploy-hook "touch /etc/letsencrypt/.renewed"

if [ -f "$MARKER" ]; then
  echo "A certificate was renewed; checking and reloading nginx"
  docker compose exec -T nginx nginx -t
  docker compose exec -T nginx nginx -s reload
  rm -f "$MARKER"
else
  echo "Nothing due for renewal"
fi

echo "=== Renewal run finished at $(date -u) ==="
