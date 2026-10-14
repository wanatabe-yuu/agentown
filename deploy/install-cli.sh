#!/bin/sh
# Install agentownctl, the Agentown cluster CLI, on macOS or Linux:
#
#   curl -fsSL https://agentown.site/cli.sh | sh
#
# Options (environment variables):
#   AGENTOWN_VERSION=v0.1.0          a specific release (default: latest)
#   AGENTOWN_INSTALL_DIR=~/.local/bin where to put it (default: /usr/local/bin if writable)
#
# The binary is checked against the release's SHA256SUMS. If cosign is
# installed, SHA256SUMS' Sigstore signature is verified too.
# Windows: download agentownctl_windows_amd64.exe from the release page.
set -eu
REPO="${AGENTOWN_REPO:-wanatabe-yuu/Agentown}"

die() { echo "error: $*" >&2; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) die "unsupported OS $(uname -s); download a binary from https://github.com/$REPO/releases" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
asset="agentownctl_${os}_${arch}"

if [ -n "${AGENTOWN_VERSION:-}" ]; then
  base="https://github.com/$REPO/releases/download/$AGENTOWN_VERSION"
else
  base="https://github.com/$REPO/releases/latest/download"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for f in "$asset" SHA256SUMS SHA256SUMS.sigstore.json; do
  curl -fsSL --retry 3 -o "$tmp/$f" "$base/$f" || die "could not download $f from $base"
done

if command -v cosign >/dev/null 2>&1; then
  cosign verify-blob --bundle "$tmp/SHA256SUMS.sigstore.json" \
    --certificate-identity-regexp "^https://github\.com/$REPO/\.github/workflows/release\.yml@refs/(tags/v|heads/main\$)" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com \
    "$tmp/SHA256SUMS" >/dev/null 2>&1 || die "SHA256SUMS is not signed by $REPO's release workflow"
  signed="signature and checksum verified"
else
  signed="checksum verified (install cosign to also verify the signature)"
fi

expected="$(awk -v f="$asset" '$2 == f {print $1}' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "$asset is not listed in SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
else
  actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
fi
[ "$expected" = "$actual" ] || die "checksum mismatch for $asset"

dir="${AGENTOWN_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then dir=/usr/local/bin; else dir="$HOME/.local/bin"; fi
fi
mkdir -p "$dir"
chmod 0755 "$tmp/$asset"
mv "$tmp/$asset" "$dir/agentownctl"

echo "installed $dir/agentownctl ($("$dir/agentownctl" version), $signed)"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) echo "note: $dir is not on your PATH; add it, e.g. export PATH=\"$dir:\$PATH\"" ;;
esac
echo "next: agentownctl init   (then edit agentown.cluster.yaml and run: agentownctl up)"
