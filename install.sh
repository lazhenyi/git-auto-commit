#!/bin/sh
# gac (git-auto-commit) installer
# https://github.com/lazhenyi/git-auto-commit
set -eu

REPO="${GAC_REPO:-lazhenyi/git-auto-commit}"
API="https://api.github.com/repos/$REPO/releases"
VERSION="${GAC_VERSION:-}"
INSTALL_DIR="${GAC_INSTALL_DIR:-}"
BIN="gac"

usage() {
  cat <<EOF
Install gac (git-auto-commit) as a self-contained binary.

Usage:
  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | sh
  sh install.sh [options]

Options:
  --version <tag>   Release to install (default: latest), e.g. --version v0.1.0
  --dir <path>      Install directory (default: \$GAC_INSTALL_DIR or ~/.local/bin)
  -h, --help        Show this help

Environment:
  GAC_INSTALL_DIR   Same as --dir
  GAC_VERSION       Same as --version
  GAC_REPO          owner/repo override (for forks)
EOF
}

die() {
  printf 'gac installer: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      VERSION="$2"
      shift 2
      ;;
    --version=*)
      VERSION="${1#*=}"
      shift
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir needs a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    --dir=*)
      INSTALL_DIR="${1#*=}"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "unknown option: $1"
      ;;
  esac
done

if command -v curl >/dev/null 2>&1; then
  download() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  download() { wget -qO "$2" "$1"; }
else
  die "curl or wget is required"
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
  linux) os=linux ;;
  darwin) os=darwin ;;
  *)
    die "unsupported OS '$os'. Download a binary manually: https://github.com/$REPO/releases"
    ;;
esac

machine=$(uname -m)
case "$machine" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die "unsupported architecture '$machine'" ;;
esac

asset="gac-$os-$arch"

if [ -n "$VERSION" ]; then
  tag=$(printf '%s' "$VERSION" | sed 's/^v//')
  release_url="$API/tags/v$tag"
  label="v$tag"
else
  release_url="$API/latest"
  label="latest"
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

download "$release_url" "$tmp/release.json" 2>/dev/null ||
  die "could not fetch the $label release. Check https://github.com/$REPO/releases"

asset_url=$(grep -o '"browser_download_url":[[:space:]]*"[^"]*"' "$tmp/release.json" |
  sed 's/.*"\(https[^"]*\)".*/\1/' |
  grep -F "/$asset" |
  head -n 1 || true)
[ -n "$asset_url" ] || die "release $label has no asset named $asset"

printf 'Downloading %s...\n' "$asset"
download "$asset_url" "$tmp/$asset" || die "download failed: $asset_url"

sums_url=$(grep -o '"browser_download_url":[[:space:]]*"[^"]*"' "$tmp/release.json" |
  sed 's/.*"\(https[^"]*\)".*/\1/' |
  grep -F "/SHA256SUMS" |
  head -n 1 || true)
if [ -n "$sums_url" ] && download "$sums_url" "$tmp/SHA256SUMS" 2>/dev/null; then
  expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | awk '{print $1}' | head -n 1 || true)
  if [ -n "$expected" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      actual=$(sha256sum "$tmp/$asset" | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      actual=$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')
    else
      actual=""
    fi
    if [ -n "$actual" ] && [ "$actual" != "$expected" ]; then
      die "checksum mismatch for $asset"
    fi
  fi
fi

if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
fi
mkdir -p "$INSTALL_DIR" || die "cannot create $INSTALL_DIR"
target="$INSTALL_DIR/$BIN"

if command -v install >/dev/null 2>&1; then
  install -m 755 "$tmp/$asset" "$target"
else
  cp "$tmp/$asset" "$target"
  chmod 755 "$target"
fi

installed=$("$target" --version)
printf 'Installed %s (%s)\n' "$target" "$installed"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\n%s is not on your PATH. Add it with:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR"
    ;;
esac

printf '\nNext steps:\n'
printf '  export GAC_API_KEY=sk-...   # or OPENAI_API_KEY / ANTHROPIC_API_KEY\n'
printf '  gac --dry-run               # preview the commit message\n'
printf '  gac -y                      # commit without asking\n'
