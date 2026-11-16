#!/bin/bash
# One-time app setup on the prod API server, run there from the project folder after the first
# ./scp-fs.sh build. The OS part (Docker, Compose, swap, cron, security updates) is done at first
# boot by ec2-user-data.sh; this script only checks it.
#
#   ./system-init.sh            # certificate for api.ceseelia.com, start the containers, renewal cron
#
# Needs node/.env on the server (see node/.env.example; never committed) and the DNS record for
# api.ceseelia.com pointing at this server (Let's Encrypt checks it over port 80).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
DOMAIN="${DOMAIN:-api.ceseelia.com}"
EMAIL="${CERT_EMAIL:-support@ceseelia.com}"

[ -f /var/lib/ceseelia-ready ] || { echo "First-boot setup (ec2-user-data.sh) hasn't finished"; exit 1; }
docker compose version >/dev/null
[ -f docker-compose.yml ] || { echo "docker-compose.yml not found in $PROJECT_DIR"; exit 1; }
[ -f node/.env ] || { echo "node/.env missing (copy node/.env.example and fill it in)"; exit 1; }
[ -d node/dist ] || { echo "node/dist missing: run ./scp-fs.sh build from your machine"; exit 1; }

# nginx won't start without its certificate, so the first one comes from certbot's own web server
# (port 80 is still free). Renewals then go through nginx (certbot-renew.sh, webroot).
mkdir -p certbot/webroot certbot/ssl
if [ ! -f "certbot/ssl/live/$DOMAIN/fullchain.pem" ]; then
  echo "Getting the first certificate for $DOMAIN..."
  docker run --rm -p 80:80 \
    -v "$PROJECT_DIR/certbot/ssl:/etc/letsencrypt" \
    certbot/certbot:v5.10.0 certonly --standalone \
    --non-interactive --agree-tos --no-eff-email --email "$EMAIL" \
    -d "$DOMAIN" --cert-name "$DOMAIN"
fi

echo "Building and starting the containers..."
docker compose up --build -d
docker compose ps

chmod +x ./certbot-renew.sh
crontab -l 2>/dev/null | grep -q 'certbot-renew.sh' || (
  crontab -l 2>/dev/null || true
  # Run with bash, so a lost executable bit can't stop renewals ("Permission denied").
  echo "0 2,14 * * * /bin/bash $PROJECT_DIR/certbot-renew.sh >> $PROJECT_DIR/certbot-renew.log 2>&1"
) | crontab -
echo "Certificate renewal cron job installed (2 AM and 2 PM UTC)."
