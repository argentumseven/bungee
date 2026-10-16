#!/usr/bin/env bash
# Source this file. All generated development state stays outside protected home directories.
_bungee_tools="${BUNGEE_TOOLS_DIR:-/workspace/.cache/bungee}"
export RUSTUP_HOME="$_bungee_tools/rustup"
export CARGO_HOME="$_bungee_tools/cargo"
export NPM_CONFIG_CACHE="$_bungee_tools/npm"
export GRADLE_USER_HOME="$_bungee_tools/gradle"
export ANDROID_HOME="$_bungee_tools/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export ANDROID_USER_HOME="$_bungee_tools/android-user"
if [ -x "$_bungee_tools/jdk/bin/javac" ]; then export JAVA_HOME="$_bungee_tools/jdk"; fi
export PATH="$CARGO_HOME/bin:${JAVA_HOME:+$JAVA_HOME/bin:}$ANDROID_HOME/platform-tools:$PATH"
unset _bungee_tools
