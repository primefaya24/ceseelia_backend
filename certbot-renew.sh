#!/bin/bash
set -e

# Paths to your certbot volumes
WEBROOT_PATH=/home/ec2-user/primedine/certbot/webroot
SSL_PATH=/home/ec2-user/primedine/certbot/ssl

echo "=== Renewal run started at $(date) ==="

# Run certbot renew inside a temporary container
docker run --rm \
  -v $WEBROOT_PATH:/var/www/certbot \
  -v $SSL_PATH:/etc/letsencrypt \
  certbot/certbot renew --webroot -w /var/www/certbot \
  --deploy-hook "echo 'Renewal succeeded at \$(date), reloading services...' && \
                 docker compose exec nginx nginx -t && \
                 docker compose restart nginx && \
                 docker compose restart node"

echo "=== Renewal run finished at $(date) ==="
