#!/bin/bash

# Exit on any error
set -e

# Check for required argument (one base domain)
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 sub-domain-name"
  exit 1
fi

# Fixed email
EMAIL="support@primefaya.com"

SUB_DOMAIN_NAME=$1
SUB_DOMAIN="$SUB_DOMAIN_NAME.dinersxpress.com"

# Run Certbot
docker run --rm \
  -v $(pwd)/certbot/webroot:/var/www/certbot \
  -v $(pwd)/certbot/ssl:/etc/letsencrypt \
  certbot/certbot certonly \
  --webroot -w /var/www/certbot \
  --agree-tos --no-eff-email --email "$EMAIL" \
  -d "$SUB_DOMAIN" \
  --cert-name "$SUB_DOMAIN"

# Reboot Proxy
sudo docker compose exec nginx nginx -t
sudo docker compose restart nginx
sudo docker compose restart node

#docker run -it --rm \
#  -v $(pwd)/certbot/ssl:/etc/letsencrypt \
#  certbot/certbot certonly \
#  --manual \
#  --preferred-challenges dns \
#  --email "$EMAIL" \
#  --agree-tos \
#  --no-eff-email \
#  -d '*.dinersxpress.com' \
#  -d dinersxpress.com \
#  --cert-name dinersxpress.com