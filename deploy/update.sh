#!/bin/sh
set -eu
cd /var/www/tesla
git pull --ff-only origin main
npm ci --no-audit --no-fund
npm run check
npm test
npm run build:server
python3 deploy/backup-state.py
nginx -t
systemctl restart tesla-link
docker compose -f receiver/compose.yaml --env-file receiver/.env up -d --build
# Nginx/systemd config changes and D1 migrations are reviewed/applied separately.
