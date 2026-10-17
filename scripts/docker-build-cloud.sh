#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
tools="${BUNGEE_TOOLS_DIR:-/workspace/.cache/bungee}"
export DOCKER_CONFIG="${DOCKER_CONFIG:-$tools/docker}"
mkdir -p "$DOCKER_CONFIG"
export http_proxy="${http_proxy:-${HTTP_PROXY:-}}" https_proxy="${https_proxy:-${HTTPS_PROXY:-}}"
args=(--build-arg HTTP_PROXY --build-arg HTTPS_PROXY --build-arg http_proxy --build-arg https_proxy --build-arg NO_PROXY --build-arg no_proxy)
proxy_host=$(python3 - <<'PY'
import os, urllib.parse
u=urllib.parse.urlparse(os.environ.get('HTTPS_PROXY',''))
print(u.hostname or '')
PY
)
if [ -n "$proxy_host" ]; then
    proxy_ip=$(getent ahostsv4 "$proxy_host" | awk 'NR==1 {print $1}')
    if [ -n "$proxy_ip" ]; then args+=(--add-host "$proxy_host:$proxy_ip"); fi
fi
if [ -f /etc/ssl/certs/ca-certificates.crt ]; then args+=(--secret id=build_ca,src=/etc/ssl/certs/ca-certificates.crt); fi
docker build "${args[@]}" -t bungee-gateway:dev -f deploy/wireguard/Dockerfile deploy
docker build "${args[@]}" -t bungee-server:dev .
