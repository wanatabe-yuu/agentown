#!/usr/bin/env bash
# Build agentownctl (the cluster CLI in cli/) for every supported platform:
#
#   scripts/build-cli.sh v0.1.0 out/
#
# Static binaries (CGO off), stripped of local paths (-trimpath), with the
# version stamped in. Release assets: agentownctl_<os>_<arch>[.exe].
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: $0 <tag> <outdir>}"
OUT="${2:?usage: $0 <tag> <outdir>}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
PLATFORMS=(linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64)
cd "$ROOT/cli"
for p in "${PLATFORMS[@]}"; do
  os="${p%/*}" arch="${p#*/}"
  ext=""; [ "$os" = windows ] && ext=".exe"
  CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" go build -trimpath \
    -ldflags "-s -w -X main.version=$TAG" -o "$OUT/agentownctl_${os}_${arch}${ext}" .
  echo "wrote $OUT/agentownctl_${os}_${arch}${ext}"
done
