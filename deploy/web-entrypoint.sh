#!/bin/sh
set -eu
: "${BUNGEE_DOMAIN:?Set the dashboard hostname or IP}"
case "${BUNGEE_ADMIN_SUBNETS:-}" in
    *[![:space:]]*) ;;
    *) echo 'Explicit administrator networks are required; refusing to serve the dashboard.' >&2; exit 1;;
esac
exec "$@"
