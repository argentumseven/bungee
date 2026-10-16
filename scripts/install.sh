#!/usr/bin/env bash
set -euo pipefail
command -v python3 >/dev/null || { echo 'Install Python 3 using your operating system package manager, then rerun this installer.' >&2; exit 1; }
exec python3 "$(dirname "${BASH_SOURCE[0]}")/bungee-host.py" install "$@"
