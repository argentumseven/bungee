#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${BUNGEE_OWNER_KEYSTORE:?Set BUNGEE_OWNER_KEYSTORE to your stable private keystore outside the repository}"
if [ ! -f "$BUNGEE_OWNER_KEYSTORE" ]; then
    echo 'Create and back up your own signing keystore first; see docs/MANAGEMENT.md.' >&2
    exit 1
fi
if [ -z "${BUNGEE_OWNER_STORE_PASSWORD:-}" ]; then
    read -r -s -p 'Keystore password: ' BUNGEE_OWNER_STORE_PASSWORD
    printf '\n' >&2
fi
export BUNGEE_OWNER_KEYSTORE BUNGEE_OWNER_STORE_PASSWORD
export BUNGEE_OWNER_KEY_ALIAS="${BUNGEE_OWNER_KEY_ALIAS:-bungee}"
trap 'unset BUNGEE_OWNER_STORE_PASSWORD BUNGEE_OWNER_KEY_PASSWORD' EXIT
bash scripts/android.sh :app:assembleRelease :app:lintRelease
source scripts/dev-env.sh
apk=android/app/build/outputs/apk/release/app-release.apk
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify --print-certs "$apk"
sha256sum "$apk"
printf 'Keep the same signing key for in-place updates (device-owner enrollment is unsupported): %s\n' "$apk"
