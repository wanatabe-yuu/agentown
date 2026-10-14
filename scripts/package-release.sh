#!/usr/bin/env bash
# Build the release assets that deploy/install.sh installs:
#
#   agentown-<tag>.tar.gz                 server bundle, web UI, default config, installer, agentownctl
#   agentown-harness-<tag>-amd64.tar.gz   agent runtime image (docker save), loaded on the host
#
#   scripts/package-release.sh v0.1.0 out/
#
# The tag must match the version in package.json (the harness image tag and the
# runtime catalog in config/agentown.yaml both use it). Checksums, signatures,
# SBOM and provenance are added by .github/workflows/release.yml.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TAG="${1:?usage: $0 <tag, e.g. v0.1.0> <outdir>}"
OUT="${2:?usage: $0 <tag> <outdir>}"
VERSION="${TAG#v}"

pkg_version="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
[ "$VERSION" = "$pkg_version" ] || { echo "tag $TAG does not match package.json version $pkg_version" >&2; exit 1; }
grep -q "image: agentown/harness:$VERSION\$" "$ROOT/config/agentown.yaml" \
  || { echo "config/agentown.yaml runtimeCatalog does not use agentown/harness:$VERSION" >&2; exit 1; }

# Reproducible timestamps inside the tarball.
export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT" log -1 --format=%ct)}"

(cd "$ROOT" && pnpm --filter @agentown/server build && pnpm build:web && pnpm build:harness)

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
DIR="$STAGE/agentown-$TAG"
mkdir -p "$DIR/server" "$DIR/config" "$DIR/bin"
cp -r "$ROOT/apps/server/dist/." "$DIR/server/"
cp -r "$ROOT/apps/web/dist" "$DIR/web"
cp "$ROOT/config/agentown.yaml" "$DIR/config/"
cp "$ROOT/deploy/install.sh" "$DIR/install.sh"
cp "$ROOT/deploy/agentownctl" "$DIR/bin/agentownctl"
cp "$ROOT/LICENSE" "$DIR/"
chmod 0755 "$DIR/install.sh" "$DIR/bin/agentownctl"
cat > "$DIR/VERSION" <<EOF
version=$TAG
commit=$(git -C "$ROOT" rev-parse HEAD)
harness_image=agentown/harness:$VERSION
EOF

tar -C "$STAGE" --sort=name --owner=0 --group=0 --numeric-owner --mtime="@$SOURCE_DATE_EPOCH" \
  -cf - "agentown-$TAG" | gzip -n > "$OUT/agentown-$TAG.tar.gz"
echo "wrote $OUT/agentown-$TAG.tar.gz"

if [ "${AGENTOWN_SKIP_IMAGE:-}" != 1 ]; then
  docker build --platform linux/amd64 -t "agentown/harness:$VERSION" "$ROOT/apps/harness"
  docker save "agentown/harness:$VERSION" | gzip -n > "$OUT/agentown-harness-$TAG-amd64.tar.gz"
  echo "wrote $OUT/agentown-harness-$TAG-amd64.tar.gz"
fi
