#!/bin/bash
# Deploy an API image from ECR on the prod server, with automatic rollback.
#
# Run by the GitHub deploy (.github/workflows/deploy-prod.yml) through SSM Run Command, which
# first stages the new docker-compose.yml, nginx.conf and this script in deploy/next/. By hand:
#   sudo bash deploy-image.sh 258084617016.dkr.ecr.us-east-1.amazonaws.com/ceseelia-node:<sha>
#
# 1. log in to ECR and pull the image;
# 2. install the staged compose file and nginx.conf (the current ones saved in deploy/prev/);
# 3. start node on the new image, wait until Docker says healthy and nginx answers /healthz;
# 4. success: remember the image in .env (compose reads NODE_IMAGE from it, so a later manual
#    `docker compose up` keeps it), reload nginx, drop old images (keeps this one and the last);
#    failure: put the previous image and files back, start them, and exit 1.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[ "$(basename "$(pwd)")" = next ] && cd ../..   # run from deploy/next/: the project is two up
PROJECT="$(pwd)"
NEW="${1:?usage: deploy-image.sh <ecr-image-uri>}"
REGISTRY="${NEW%%/*}"
REGION="us-east-1"

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

PREV="$(docker inspect -f '{{.Config.Image}}' node 2>/dev/null || true)"
log "current image: ${PREV:-none}"
log "new image:     $NEW"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker pull -q "$NEW" >/dev/null
log "pulled"

mkdir -p deploy/prev
cp -f docker-compose.yml deploy/prev/docker-compose.yml
cp -f nginx/nginx.conf deploy/prev/nginx.conf
OLD_CONF_SUM="$(sha256sum nginx/nginx.conf | cut -d' ' -f1)"
if [ -d deploy/next ]; then
  [ -f deploy/next/docker-compose.yml ] && cp -f deploy/next/docker-compose.yml docker-compose.yml
  [ -f deploy/next/nginx.conf ] && cp -f deploy/next/nginx.conf nginx/nginx.conf
  [ -f deploy/next/deploy-image.sh ] && cp -f deploy/next/deploy-image.sh deploy-image.sh
fi

start_node() { NODE_IMAGE="$1" docker compose up -d --no-build --no-deps node; }

# Healthy = Docker's HEALTHCHECK passes and nginx serves /healthz over TLS. A container that
# restarts (it crashed) fails at once instead of waiting out the timeout.
wait_healthy() {
  for _ in $(seq 1 36); do
    local status restarts
    status="$(docker inspect -f '{{.State.Health.Status}}' node 2>/dev/null || echo missing)"
    restarts="$(docker inspect -f '{{.RestartCount}}' node 2>/dev/null || echo 0)"
    if [ "$restarts" != "0" ] || [ "$status" = "unhealthy" ]; then
      log "node is $status after $restarts restart(s)"
      docker logs --tail 30 node 2>&1 || true
      return 1
    fi
    if [ "$status" = "healthy" ]; then
      curl -fsS --max-time 5 --resolve api.ceseelia.com:443:127.0.0.1 https://api.ceseelia.com/healthz >/dev/null && return 0
    fi
    sleep 5
  done
  log "not healthy after 3 minutes"
  return 1
}

reload_nginx() {
  # A changed compose file recreates nginx; a changed nginx.conf (bind-mounted) needs a reload.
  docker compose up -d --no-deps nginx
  if [ "$(sha256sum nginx/nginx.conf | cut -d' ' -f1)" != "$1" ]; then
    docker exec nginx nginx -t && docker exec nginx nginx -s reload && log "nginx reloaded"
  fi
}

start_node "$NEW"
if wait_healthy; then
  echo "NODE_IMAGE=$NEW" > .env
  reload_nginx "$OLD_CONF_SUM"
  # Keep the new image and the one before it (a quick manual rollback); remove older ones.
  docker images --format '{{.Repository}}:{{.Tag}}' | grep "/ceseelia-node:" \
    | grep -v -x -F -e "$NEW" -e "${PREV:-none}" | xargs -r docker rmi >/dev/null 2>&1 || true
  docker image prune -f >/dev/null
  chown -R ec2-user:ec2-user "$PROJECT/deploy" "$PROJECT/.env" 2>/dev/null || true
  log "deployed $NEW"
  exit 0
fi

log "rolling back to ${PREV:-nothing}"
cp -f deploy/prev/docker-compose.yml docker-compose.yml
cp -f deploy/prev/nginx.conf nginx/nginx.conf
if [ -n "$PREV" ]; then
  start_node "$PREV"
  if wait_healthy; then log "rolled back: $PREV is serving again"; else log "ROLLBACK ALSO UNHEALTHY: check the server"; fi
fi
exit 1
