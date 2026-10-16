#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
: "${ANDROID_HOME:?Set ANDROID_HOME to an SDK with platform 36 and NDK 28.2.13676358}"
export GOFLAGS="${GOFLAGS:-} -buildvcs=false"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
[[ -f "$ANDROID_NDK_HOME/source.properties" ]] || { echo 'Install ndk;28.2.13676358 with sdkmanager' >&2; exit 1; }
[[ "$(go env GOVERSION)" == go1.26.9 ]] || { echo 'Go 1.26.9 is required' >&2; exit 1; }
go install golang.org/x/mobile/cmd/gomobile@v0.0.0-20261011034528-197770444867
go install golang.org/x/mobile/cmd/gobind@v0.0.0-20261011034528-197770444867
mkdir -p android/app/libs
cd native/transport
# gobind needs its pinned support module in the build list as well as the tools.
gomobile bind -trimpath -ldflags="-s -w" -target=android/arm64,android/amd64 -androidapi=31 -javapkg=org.bungee -o ../../android/app/libs/bungee-transport.aar .
