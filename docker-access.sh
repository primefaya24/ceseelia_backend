#!/bin/bash

set -e

if [ "$1" == "nginx" ]; then
  sudo docker exec -it nginx bash
elif [ "$1" == "node" ]; then
  sudo docker exec -it node bash
else
  echo "❌ Usage: $0 [nginx|node]"
  exit 1
fi
