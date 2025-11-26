#!/bin/bash

set -e  # Exit on any error
set -o pipefail

echo "🚀 Updating system packages..."
sudo yum update -y

echo "📦 Installing Docker..."
sudo amazon-linux-extras install docker -y
sudo usermod -aG docker ec2-user
sudo systemctl enable docker
sudo systemctl start docker

echo "🐳 Docker installed. Version:"
docker --version

echo "🧩 Installing Docker Compose v2..."
mkdir -p ~/.docker/cli-plugins
curl -SL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 \
  -o ~/.docker/cli-plugins/docker-compose
chmod +x ~/.docker/cli-plugins/docker-compose

echo "🔗 Verifying Docker Compose installation..."
docker compose version

# Optional wait for Docker daemon
until docker info >/dev/null 2>&1; do
  echo "⏳ Waiting for Docker to start..."
  sleep 1
done

# Define your project directory
PROJECT_DIR=/home/ec2-user/primedine

if [ ! -d "$PROJECT_DIR" ]; then
  echo "❌ ERROR: Project directory $PROJECT_DIR does not exist!"
  exit 1
fi

echo "📂 Changing to project directory: $PROJECT_DIR"
cd "$PROJECT_DIR"

if [ ! -f docker-compose.yml ]; then
  echo "❌ ERROR: docker-compose.yml not found in $PROJECT_DIR"
  exit 1
fi

echo "📦 Building and starting Docker containers..."
docker compose up --build -d

echo "✅ System setup complete. Running containers:"
docker ps

# Make sure the certbot-renew.sh script is executable
chmod +x ./certbot-renew.sh

echo "⏰ Setting up certbot renewal cron job for ec2-user..."

# Add the cron job only if it doesn't already exist
crontab -l 2>/dev/null | grep -q 'certbot-renew.sh' || (
  crontab -l 2>/dev/null > /tmp/ec2user_cron_backup || true
  echo "0 2,14 * * * /home/ec2-user/primedine/certbot-renew.sh >> /home/ec2-user/primedine/certbot-renew.log 2>&1" >> /tmp/ec2user_cron_backup
  crontab /tmp/ec2user_cron_backup
  rm /tmp/ec2user_cron_backup
)

echo "✅ Certbot renewal cron job installed (runs 2 AM and 2 PM daily)."


