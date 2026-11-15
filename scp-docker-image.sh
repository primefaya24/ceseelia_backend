#!/bin/bash

docker build -t primedine-node:latest ./node
docker save primedine-node:latest -o node-image.tar
scp -i /home/vboxuser/Documents/pem/primehost-0.pem node-image.tar ec2-user@3.215.232.243:/home/ec2-user/
