#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
source scripts/dev-env.sh
tools="${BUNGEE_TOOLS_DIR:-/workspace/.cache/bungee}"
mkdir -p "$tools" "$ANDROID_USER_HOME" "$tools/java-home"
if [ ! -x "$CARGO_HOME/bin/rustup" ]; then
    curl --fail --silent --show-error --location https://sh.rustup.rs -o "$tools/rustup-init.sh"
    sh "$tools/rustup-init.sh" -y --profile minimal --no-modify-path --default-toolchain none
fi
rustup toolchain install 1.90.0 --profile minimal --component rustfmt --component clippy
if [ ! -x "$tools/jdk/bin/javac" ]; then
    url='https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_linux_hotspot_21.0.12.1_1.tar.gz'
    curl --fail --silent --show-error --location "$url" -o "$tools/jdk.tar.gz"
    curl --fail --silent --show-error --location "$url.sha256.txt" -o "$tools/jdk.sha256"
    python3 - "$tools" <<'PY'
import hashlib, pathlib, sys
p=pathlib.Path(sys.argv[1])
assert hashlib.file_digest((p/'jdk.tar.gz').open('rb'),'sha256').hexdigest()==(p/'jdk.sha256').read_text().split()[0], 'JDK checksum mismatch'
PY
    mkdir -p "$tools/jdk"
    tar -xf "$tools/jdk.tar.gz" -C "$tools/jdk" --strip-components=1
fi
source scripts/dev-env.sh
if [ ! -x "$ANDROID_HOME/cmdline-tools/19.0/bin/sdkmanager" ]; then
    curl --fail --silent --show-error --location https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip -o "$tools/android-tools.zip"
    printf '%s  %s\n' '5fdcc763663eefb86a5b8879697aa6088b041e70' "$tools/android-tools.zip" | sha1sum --check --status
    # This SHA-1 is Google's checksum from the HTTPS repository manifest; TLS remains enabled.
    mkdir -p "$ANDROID_HOME/cmdline-tools" "$tools/android-tools-unpack"
    unzip -q -o "$tools/android-tools.zip" -d "$tools/android-tools-unpack"
    mv "$tools/android-tools-unpack/cmdline-tools" "$ANDROID_HOME/cmdline-tools/19.0"
fi
# Accept only licenses prompted for these requested SDK packages through the official tool.
sdk_args=("--sdk_root=$ANDROID_HOME")
mapfile -t sdk_proxy < <(python3 - <<'PY'
import os, urllib.parse
u=urllib.parse.urlparse(os.environ.get('HTTPS_PROXY',''))
if u.hostname:
 print(u.hostname)
 print(u.port or 80)
PY
)
if [ "${#sdk_proxy[@]}" -eq 2 ]; then sdk_args+=(--proxy=http "--proxy_host=${sdk_proxy[0]}" "--proxy_port=${sdk_proxy[1]}"); fi
if [ -f /etc/ssl/certs/java/cacerts ]; then export SDKMANAGER_OPTS="${SDKMANAGER_OPTS:-} -Djavax.net.ssl.trustStore=/etc/ssl/certs/java/cacerts"; fi
"$ANDROID_HOME/cmdline-tools/19.0/bin/sdkmanager" "${sdk_args[@]}" 'platforms;android-36' 'build-tools;35.0.0' 'platform-tools' < <(printf 'y\n%.0s' {1..30})
npm ci --no-audit --no-fund
npm ci --prefix web --no-audit --no-fund
npm run build --prefix web
cargo build --locked --manifest-path server/Cargo.toml -j 4
bash scripts/android.sh :app:assembleDebug
