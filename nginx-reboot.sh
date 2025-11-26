sudo docker compose exec nginx nginx -t   # Check config syntax
sudo docker compose exec nginx nginx -s reload  # Reload without downtime