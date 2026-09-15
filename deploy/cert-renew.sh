#!/bin/sh
set -eu
[ "${RENEWED_LINEAGE:-}" = /etc/letsencrypt/live/tesla-link ] || exit 0
cd /var/www/tesla
install -m 644 "$RENEWED_LINEAGE/fullchain.pem" receiver/certs/fullchain.pem
install -o root -g 65532 -m 640 "$RENEWED_LINEAGE/privkey.pem" receiver/certs/privkey.pem
# Use the trusted root bundle so routine intermediate rotations remain valid.
install -m 644 /etc/ssl/certs/ISRG_Root_X1.pem receiver/certs/ca.pem
nginx -t
systemctl reload nginx
docker compose -f receiver/compose.yaml --env-file receiver/.env restart telemetry bridge
