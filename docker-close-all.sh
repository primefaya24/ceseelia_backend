sudo docker stop $(docker ps -q)
sudo docker rm $(docker ps -aq)
sudo docker rmi $(docker images -q)
sudo docker ps