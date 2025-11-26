cd .. &&
docker kill api && docker rm api && # Comment out on first run
docker system prune -a && # Comment out on first run
docker build ./dinersxpress -t dinersxpress-web-server:v1 &&
cd dinersxpress/ &&
docker run --name routes -p 3100:3100/tcp -d dinersxpress-web-server:v1 &&
docker ps -a