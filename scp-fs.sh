#!/bin/bash

# Example usage: ./scp-fs.sh build

if [ "$1" = "build" ]; then
  echo "Building the Node.js project..."
  cd ./node
  sudo npm run build || { echo "Build failed"; exit 1; }
  cd ../
else
  echo "Skipping build step"
fi

# Sync files to EC2
rsync -avz \
  --exclude 'node_modules' \
  -e "ssh -i /home/vboxuser/Documents/pem/primehost-0.pem" \
  . ec2-user@3.215.232.243:/home/ec2-user/primedine/
