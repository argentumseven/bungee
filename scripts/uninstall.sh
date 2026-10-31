#!/usr/bin/env bash
set -euo pipefail
command -v python3 >/dev/null || { echo 'Python 3 is required to uninstall Bungee.' >&2; exit 1; }
exec python3 "$(dirname "${BASH_SOURCE[0]}")/bungee-host.py" uninstall "$@"
