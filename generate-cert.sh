#!/bin/bash

# Exit on any error
set -e

# Always from the project folder, so the certbot folders match docker-compose.yml.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for required argument (one base domain)
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 sub-domain-name"
  exit 1
fi

# The Let's Encrypt account email (override: CERT_EMAIL=... ./generate-cert.sh api).
EMAIL="${CERT_EMAIL:-support@ceseelia.com}"

SUB_DOMAIN_NAME=$1
BASE_DOMAIN="${BASE_DOMAIN:-ceseelia.com}"
SUB_DOMAIN="$SUB_DOMAIN_NAME.$BASE_DOMAIN"   # e.g. ./generate-cert.sh api -> api.ceseelia.com

# Run Certbot
docker run --rm \
  -v $(pwd)/certbot/webroot:/var/www/certbot \
  -v $(pwd)/certbot/ssl:/etc/letsencrypt \
  certbot/certbot:v5.10.0 certonly \
  --webroot -w /var/www/certbot \
  --agree-tos --no-eff-email --email "$EMAIL" \
  -d "$SUB_DOMAIN" \
  --cert-name "$SUB_DOMAIN"

# Load the new certificate
sudo docker compose exec -T nginx nginx -t
sudo docker compose exec -T nginx nginx -s reload
