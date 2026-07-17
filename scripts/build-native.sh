#!/usr/bin/env bash
# Builds the native addon and copies it to prebuilds/<platform>-<arch>/libripgrep.node
set -euo pipefail
cd "$(dirname "$0")/.."

cargo build --release --manifest-path native/Cargo.toml

TARGET_DIR="${CARGO_TARGET_DIR:-native/target}"
PLATFORM_ARCH="$(node -p 'process.platform + "-" + process.arch')"
case "$(node -p 'process.platform')" in
	linux) SRC="$TARGET_DIR/release/liblibripgrep.so" ;;
	darwin) SRC="$TARGET_DIR/release/liblibripgrep.dylib" ;;
	*) echo "unsupported platform" >&2; exit 1 ;;
esac

mkdir -p "prebuilds/$PLATFORM_ARCH"
cp "$SRC" "prebuilds/$PLATFORM_ARCH/libripgrep.node"
echo "built prebuilds/$PLATFORM_ARCH/libripgrep.node"
