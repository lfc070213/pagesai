#!/bin/bash
set -euo pipefail
umask 077
if [ ! -s /data/db/.pagesai-cluster-key ]; then
  head -c 512 /dev/urandom | base64 > /data/db/.pagesai-cluster-key
fi
chown mongodb:mongodb /data/db/.pagesai-cluster-key
chmod 400 /data/db/.pagesai-cluster-key
exec /usr/local/bin/docker-entrypoint.sh mongod --bind_ip_all --replSet pagesai --keyFile /data/db/.pagesai-cluster-key
