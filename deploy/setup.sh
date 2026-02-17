#!/usr/bin/env bash
# Configures nginx and systemd services for p0.
# Assumes bun and app dependencies are already installed.
# Usage: sudo APP_USER=<user> APP_DIR=<path> bash deploy/setup.sh
set -euo pipefail

usage() {
  cat <<EOF
Usage:
  sudo APP_USER=<user> APP_DIR=<repo_root> [BUN_BIN=/path/to/bun] bash deploy/setup.sh

Example:
  sudo APP_USER=ubuntu APP_DIR=/opt/paulie bash deploy/setup.sh
  sudo APP_USER=ubuntu APP_DIR=/opt/paulie BUN_BIN=/home/ubuntu/.bun/bin/bun bash deploy/setup.sh

Notes:
  - This script is for Debian/Ubuntu systems with systemd.
  - Bun must be installed and available for APP_USER.
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

print_service_debug() {
  local svc="$1"
  echo "---- systemctl status ${svc}.service ----" >&2
  systemctl status "${svc}.service" --no-pager || true
  echo "---- journalctl -xeu ${svc}.service ----" >&2
  journalctl -xeu "${svc}.service" --no-pager -n 120 || true
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$(uname -s)" != "Linux" ]]; then
  die "Unsupported OS: $(uname -s). This deploy script targets Linux/systemd hosts."
fi

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run as root (e.g. via sudo)."
fi

APP_USER="${APP_USER:-}"
APP_DIR="${APP_DIR:-}"

[[ -n "$APP_USER" ]] || {
  usage
  die "APP_USER is required."
}

[[ -n "$APP_DIR" ]] || {
  usage
  die "APP_DIR is required."
}

[[ -d "$APP_DIR" ]] || die "APP_DIR does not exist: $APP_DIR"
[[ -f "$APP_DIR/deploy/nginx.conf" ]] || die "Missing file: $APP_DIR/deploy/nginx.conf"
[[ -f "$APP_DIR/deploy/pzero-api.service" ]] || die "Missing file: $APP_DIR/deploy/pzero-api.service"
[[ -f "$APP_DIR/deploy/pzero-indexer.service" ]] || die "Missing file: $APP_DIR/deploy/pzero-indexer.service"

command -v apt-get >/dev/null 2>&1 || die "apt-get not found."
command -v systemctl >/dev/null 2>&1 || die "systemctl not found."
command -v sudo >/dev/null 2>&1 || die "sudo not found."

APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6 || true)"
[[ -n "$APP_HOME" ]] || APP_HOME="/home/$APP_USER"

if [[ -n "${BUN_BIN:-}" ]]; then
  [[ -x "$BUN_BIN" ]] || die "Provided BUN_BIN is not executable: $BUN_BIN"
else
  # command -v can fail under sudo due to PATH/profile differences; try common locations too.
  BUN_BIN="$(sudo -u "$APP_USER" env PATH="$PATH" bash -lc 'command -v bun || true')"
  if [[ -z "$BUN_BIN" && -x "$APP_HOME/.bun/bin/bun" ]]; then
    BUN_BIN="$APP_HOME/.bun/bin/bun"
  fi
  if [[ -z "$BUN_BIN" && -x "/usr/local/bin/bun" ]]; then
    BUN_BIN="/usr/local/bin/bun"
  fi
  if [[ -z "$BUN_BIN" && -x "/usr/bin/bun" ]]; then
    BUN_BIN="/usr/bin/bun"
  fi
fi
[[ -n "${BUN_BIN:-}" ]] || die "bun not found for APP_USER=$APP_USER. Install bun for that user first, or pass BUN_BIN=/path/to/bun."

echo "==> User: $APP_USER | Dir: $APP_DIR | Bun: $BUN_BIN"

echo "==> Installing nginx"
apt-get update
apt-get install -y --no-install-recommends nginx

echo "==> Configuring nginx"
sed "s|__APP_DIR__|$APP_DIR|g" "$APP_DIR/deploy/nginx.conf" \
  > /etc/nginx/sites-available/default
nginx -t
if ! systemctl enable --now nginx; then
  print_service_debug nginx
  die "nginx failed to start"
fi
systemctl reload nginx || die "nginx reload failed"

echo "==> Installing systemd services"
for svc in pzero-api pzero-indexer; do
  sed -e "s|__APP_USER__|$APP_USER|g" \
      -e "s|__APP_DIR__|$APP_DIR|g" \
      -e "s|__BUN_BIN__|$BUN_BIN|g" \
      "$APP_DIR/deploy/$svc.service" > "/etc/systemd/system/$svc.service"
done
systemctl daemon-reload
if ! systemctl enable --now pzero-api pzero-indexer; then
  print_service_debug pzero-api
  print_service_debug pzero-indexer
  die "one or more pzero services failed to start"
fi

echo "==> Done"
systemctl status nginx pzero-api pzero-indexer --no-pager || true
