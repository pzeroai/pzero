#!/usr/bin/env bash
# Configures nginx and systemd services for p0.
# Assumes bun and app dependencies are already installed.
# Usage: sudo APP_USER=<user> APP_DIR=<path> bash deploy/setup.sh
set -euo pipefail

APP_USER="${APP_USER:?Set APP_USER to the user that will run the services}"
APP_DIR="${APP_DIR:?Set APP_DIR to the repo root (e.g. /opt/paulie)}"
BUN_BIN="$(sudo -u "$APP_USER" bash -c 'which bun')"

echo "==> User: $APP_USER | Dir: $APP_DIR | Bun: $BUN_BIN"

echo "==> Installing nginx"
apt-get update && apt-get install -y --no-install-recommends nginx

echo "==> Configuring nginx"
sed "s|__APP_DIR__|$APP_DIR|g" "$APP_DIR/deploy/nginx.conf" \
  > /etc/nginx/sites-available/default
nginx -t && systemctl enable --now nginx && systemctl reload nginx

echo "==> Installing systemd services"
for svc in paulie-api paulie-indexer; do
  sed -e "s|__APP_USER__|$APP_USER|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__BUN_BIN__|$BUN_BIN|g" \
      "$APP_DIR/deploy/$svc.service" > "/etc/systemd/system/$svc.service"
done
systemctl daemon-reload
systemctl enable --now paulie-api paulie-indexer

echo "==> Done"
systemctl status paulie-api paulie-indexer --no-pager
