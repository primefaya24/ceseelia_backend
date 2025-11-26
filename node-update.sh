echo "[⏳] Starting Node app update..."

# 1. Rebuild the Docker image
docker compose build node

# 2. Restart the container with the new image
docker compose up -d --no-deps --build node

# 3. Clean up unused layers and saves disk space
docker image prune -f

# 4. Reboot node server
#sudo docker compose restart node

echo "[✅] Update complete."