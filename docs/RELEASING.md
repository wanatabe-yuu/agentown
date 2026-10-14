# Releases and supply chain

## Cutting a release

1. Set the new version in `package.json` (root) and in the `image:` entries of `runtimeCatalog` in `config/agentown.yaml`. `scripts/package-release.sh` stops if either does not match the tag. Also update the image tag in the `image` script of `apps/harness/package.json` and in `scripts/dev-k3s.sh`; development still uses those two and they would otherwise keep the old tag.
2. Merge to `main`, then push the tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. The `.github/workflows/release.yml` workflow runs the tests, builds, signs, and creates a GitHub Release with these files:

| File | Contents |
|---|---|
| `agentown-<tag>.tar.gz` | bundled server (`server/main.mjs`), web UI, `config/agentown.yaml`, `install.sh`, `bin/agentownctl` |
| `agentown-harness-<tag>-amd64.tar.gz` | agent runtime image (`docker save`), loaded straight into k3s' containerd or Docker |
| `agentown-<tag>.sbom.cdx.json` | CycloneDX SBOM of the repository (from the lockfile) |
| `SHA256SUMS` | checksums of all the files above |
| `SHA256SUMS.sigstore.json` | keyless Sigstore signature of `SHA256SUMS` |

Hosts install or upgrade with `curl -fsSL https://agentown.site/install.sh | sudo bash`, or `sudo agentownctl upgrade`. See [GCP.md](GCP.md).

To try a release build locally: `scripts/package-release.sh v0.1.0 out/` (needs Docker). Skip the image build with `AGENTOWN_SKIP_IMAGE=1`.

## Supply chain: what protects against what

| Risk | Mitigation |
|---|---|
| Release files swapped in transit or on GitHub | `install.sh` verifies the Sigstore signature on `SHA256SUMS`. The certificate must have been issued by GitHub Actions OIDC to **exactly** `wanatabe-yuu/Agentown/.github/workflows/release.yml` running from a `v*` tag. Only then is each file checked with `sha256sum`. Any failure stops the install. |
| The signature verification tool swapped | `install.sh` pins `cosign` by version and SHA-256. |
| Not knowing which commit a build came from | Every file has a SLSA build-provenance attestation (`actions/attest-build-provenance`) recording the repository, commit, workflow and runner. `VERSION` inside the tarball records the commit. |
| A third-party action compromised and its tag moved | Every GitHub Action is pinned to a commit SHA (the tag is noted in a comment). Dependabot opens PRs for new versions. |
| The `node:22-alpine` base image changed | `apps/harness/Dockerfile` pins it by digest. Dependabot (`docker` ecosystem) bumps the digest. |
| npm dependencies changing silently | `pnpm install --frozen-lockfile` in CI and release. Only `esbuild` may run install scripts (`onlyBuiltDependencies`). |
| A poisoned CI cache reaching a signed build | The release job uses no dependency cache. |
| The workflow token being abused | Default permissions are `contents: read`. Only the release job gets `contents: write`, `id-token: write`, `attestations: write`. `actions/checkout` runs with `persist-credentials: false`. |
| Knowing what a release contains | A CycloneDX SBOM ships with it, and it is listed in `SHA256SUMS`, so it is signed too. |

Remaining gaps to be aware of:

- `curl … install.sh | sudo bash` trusts TLS and the `agentown.site` page (GitHub Pages, built from `main`). If you need more, download `install.sh` from the Release page, verify it as shown below, and run it then. From the second install on, `agentownctl upgrade` uses the `install.sh` inside the already-verified release instead of fetching it from the website.
- NodeSource, Docker and k3s are installed through their official channels: apt repositories with GPG signatures, and the k3s installer checks the binary's SHA-256. Agentown does not pin these.
- The runtime image is built for `linux/amd64` only.
- Turn on **branch protection** for `main` and **tag protection** (a ruleset) for `v*`: anyone who can push a tag can produce a validly signed release.

## Verifying a release yourself

```bash
TAG=v0.1.0
gh release download "$TAG" --repo wanatabe-yuu/Agentown

# 1) Provenance (gh must be logged in)
gh attestation verify "agentown-$TAG.tar.gz" --repo wanatabe-yuu/Agentown

# 2) Signature + checksums, exactly as install.sh does it
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/wanatabe-yuu/Agentown/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c SHA256SUMS
```

## agentown.site

The `.github/workflows/site.yml` workflow publishes `site/` together with `deploy/install.sh` (as `/install.sh`) to GitHub Pages whenever they change on `main`. One-time setup:

1. Repository **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Pages → Custom domain**: `agentown.site`, then enable **Enforce HTTPS** once the certificate has been issued.
3. DNS for `agentown.site` at your domain registrar:
   - `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `AAAA @` → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
   - `CNAME www` → `wanatabe-yuu.github.io`
4. **Verify the domain** in your GitHub account settings (Pages → Verified domains) so nobody else can claim `agentown.site` on Pages.
