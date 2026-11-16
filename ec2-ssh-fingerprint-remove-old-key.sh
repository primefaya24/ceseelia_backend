#!/bin/bash
# Forget the server's old host key (after the instance is replaced behind the same IP).
source "$(dirname "${BASH_SOURCE[0]}")/server.conf"
ssh-keygen -R "$SERVER_HOST"
