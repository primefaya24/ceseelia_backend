#!/bin/bash

set -e

# Default tail lines
TAIL_LINES=100

if [ -n "$2" ]; then
  TAIL_LINES=$2
fi

if [ "$1" == "nginx" ]; then
  sudo docker logs -f --tail "$TAIL_LINES" nginx 2>&1 | ccze -A
elif [ "$1" == "node" ]; then
  sudo docker logs -f --tail "$TAIL_LINES" node 2>&1 | ccze -A
else
  echo "❌ Usage: $0 [nginx|node] [number_of_lines]"
  exit 1
fi
