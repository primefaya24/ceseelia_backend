#!/bin/bash
# First-boot setup for the Ceseelia API server (Amazon Linux 2023, x86_64), passed as EC2 user data.
# Installs Docker + Compose + Buildx (pinned), 1 GB swap, cron, log rotation and automatic security
# updates. The app itself is copied over afterwards (scp-fs.sh) and started with system-init.sh.
# Progress: /var/log/cloud-init-output.log on the server; done when /var/lib/ceseelia-ready exists.
set -euxo pipefail

COMPOSE_VERSION=v2.40.3
BUILDX_VERSION=v0.29.1

dnf -y upgrade --refresh
dnf -y install docker cronie rsync dnf-automatic

# Docker: capped local logs (the API's logs go to CloudWatch; this covers nginx and the rest).
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
EOF
systemctl enable --now docker
usermod -aG docker ec2-user

# Compose and Buildx as system-wide CLI plugins (pinned; update on purpose).
PLUGINS=/usr/local/lib/docker/cli-plugins
mkdir -p "$PLUGINS"
curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" -o "$PLUGINS/docker-compose"
curl -fsSL "https://github.com/docker/buildx/releases/download/${BUILDX_VERSION}/buildx-${BUILDX_VERSION}.linux-amd64" -o "$PLUGINS/docker-buildx"
chmod +x "$PLUGINS/docker-compose" "$PLUGINS/docker-buildx"

# 1 GB swap: a t3.micro has 1 GB of RAM.
if ! swapon --show | grep -q /swapfile; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi
cat > /etc/sysctl.d/90-ceseelia.conf <<'EOF'
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
sysctl --system

# cron runs the certificate renewal (system-init.sh adds the job).
systemctl enable --now crond

# Security updates applied automatically each day.
sed -i 's/^upgrade_type.*/upgrade_type = security/; s/^apply_updates.*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer

mkdir -p /home/ec2-user/ceseelia
chown ec2-user:ec2-user /home/ec2-user/ceseelia

docker version
docker compose version
docker buildx version
docker run --rm hello-world
touch /var/lib/ceseelia-ready
