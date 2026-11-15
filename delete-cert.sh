#!/bin/bash

# Exit on error
set -e

# Check for domain input
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 subdomain.domain.com"
  exit 1
fi

BASE_DOMAIN=$1

# Certbot stores these in:
SSL_DIR="$(pwd)/certbot/ssl"

# Remove cert directories and renewal config
rm -rf "$SSL_DIR/live/$BASE_DOMAIN"
rm -rf "$SSL_DIR/live/$BASE_DOMAIN-0001"
rm -rf "$SSL_DIR/archive/$BASE_DOMAIN"
rm -rf "$SSL_DIR/archive/$BASE_DOMAIN-0001"
rm -f "$SSL_DIR/renewal/$BASE_DOMAIN.conf"
rm -f "$SSL_DIR/renewal/$BASE_DOMAIN-0001.conf"

echo "✅ Certificate for $BASE_DOMAIN (and any -0001 variants) deleted."

# Reboot Proxy
sudo docker compose restart node
