#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/dev-env.sh
tools="${BUNGEE_TOOLS_DIR:-/workspace/.cache/bungee}"
mkdir -p "$tools/java-home"
args=("-Duser.home=$tools/java-home")
if [ -f /etc/ssl/certs/java/cacerts ]; then args+=("-Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"); fi
# Java does not automatically use the platform's HTTPS_PROXY binding. Read host/port only.
mapfile -t proxy_parts < <(python3 - <<'PY'
import os, urllib.parse
u=urllib.parse.urlparse(os.environ.get('HTTPS_PROXY',''))
if u.hostname:
 print(u.hostname)
 print(u.port or 80)
PY
)
if [ "${#proxy_parts[@]}" -eq 2 ]; then
    args+=("-Dhttps.proxyHost=${proxy_parts[0]}" "-Dhttps.proxyPort=${proxy_parts[1]}" "-Dhttp.proxyHost=${proxy_parts[0]}" "-Dhttp.proxyPort=${proxy_parts[1]}")
fi
cd android
exec ./gradlew "${args[@]}" --no-daemon "$@"
