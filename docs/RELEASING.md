# Releases and supply chain

## Cutting a release

1. Set the new version in every `package.json` (root, `packages/*`, `apps/*`) and in the `image:` entries of `runtimeCatalog` in `config/agentown.yaml`. `scripts/package-release.sh` stops if the root version or the catalog does not match the tag. The dev scripts read the version from `package.json`. On upgrade, `install.sh` moves `agentown/harness:` images in the host's `/etc/agentown/agentown.yaml` to the new tag (keeping a backup); other images are left alone.
2. Merge to `main`, then start the release, either way:
   - **Actions → Release → Run workflow** on `main`. The workflow reads the version from `package.json`, refuses if that tag already exists, and creates the tag `v<version>` at the commit it built.
   - or push the tag yourself, e.g. `git tag v0.2.0 && git push origin v0.2.0`.

   Do not create the release by hand on GitHub: the workflow creates it, and the installer only accepts what the workflow signed.
3. The `.github/workflows/release.yml` workflow runs the tests, builds, signs, and creates a GitHub Release with these files:

| File | Contents |
|---|---|
| `agentown-<tag>.tar.gz` | bundled server (`server/main.mjs`), web UI, `config/agentown.yaml`, `install.sh`, `bin/agentownctl` |
| `install.sh` | the installer, also published on its own so `releases/latest/download/install.sh` always points at the newest one |
| `agentownctl_<os>_<arch>[.exe]` | the cluster CLI for linux/darwin (amd64, arm64) and windows/amd64 |
| `install-cli.sh` | installs the CLI on macOS/Linux (checks `SHA256SUMS`, and the signature if `cosign` is present) |
| `uninstall.sh` | removes Agentown from a host; also inside the tarball, used by `agentownctl uninstall` |
| `agentown-harness-<tag>-amd64.tar.gz` | agent runtime image (`docker save`), loaded straight into k3s' containerd or Docker |
| `agentown-<tag>.sbom.cdx.json` | CycloneDX SBOM of the repository (from the lockfile) |
| `SHA256SUMS` | checksums of all the files above |
| `SHA256SUMS.sigstore.json` | keyless Sigstore signature of `SHA256SUMS` |

Hosts install or upgrade with `curl -fsSL https://github.com/wanatabe-yuu/Agentown/releases/latest/download/install.sh | sudo bash`, or `sudo agentownctl upgrade`. See [GCP.md](GCP.md).

To try a release build locally: `scripts/package-release.sh v0.1.0 out/` (needs Docker). Skip the image build with `AGENTOWN_SKIP_IMAGE=1`.

## Supply chain: what protects against what

| Risk | Mitigation |
|---|---|
| Release files swapped in transit or on GitHub | `install.sh` verifies the Sigstore signature on `SHA256SUMS`. The certificate must have been issued by GitHub Actions OIDC to **exactly** `wanatabe-yuu/Agentown/.github/workflows/release.yml` running from a `v*` tag or from `main`. Only then is each file checked with `sha256sum`. Any failure stops the install. |
| The signature verification tool swapped | `install.sh` pins `cosign` by version and SHA-256. |
| Not knowing which commit a build came from | Every file has a SLSA build-provenance attestation (`actions/attest-build-provenance`) recording the repository, commit, workflow and runner. `VERSION` inside the tarball records the commit. |
| A third-party action compromised and its tag moved | Every GitHub Action is pinned to a commit SHA (the tag is noted in a comment). Dependabot opens PRs for new versions. |
| The `node:24-alpine` base image changed | `apps/harness/Dockerfile` pins it by digest. Dependabot (`docker` ecosystem) bumps the digest. |
| A freshly published dependency release that turns out malicious or broken | Dependabot only proposes releases at least 14 days old (`cooldown`). Node majors (`node` image, `@types/node`) are not proposed; they are upgraded by hand across CI, installers and the agent image. |
| npm dependencies changing silently | `pnpm install --frozen-lockfile` in CI and release. Only `esbuild` may run install scripts (`onlyBuiltDependencies`). |
| A poisoned CI cache reaching a signed build | The release job uses no dependency cache. |
| The workflow token being abused | Default permissions are `contents: read`. Only the release job gets `contents: write`, `id-token: write`, `attestations: write`. `actions/checkout` runs with `persist-credentials: false`. |
| Knowing what a release contains | A CycloneDX SBOM ships with it, and it is listed in `SHA256SUMS`, so it is signed too. |

Remaining gaps to be aware of:

- `curl … install.sh | sudo bash` trusts TLS and GitHub for the installer itself: the script that does the verifying is not verified before it runs. If you need more, download `install.sh` and `SHA256SUMS*` from the Release page, verify them as shown below, and run it then. `install.sh` is listed in the signed `SHA256SUMS`. From the second install on, `agentownctl upgrade` uses the `install.sh` inside the already-verified release.
- NodeSource, Docker and k3s are installed through their official channels: apt repositories with GPG signatures, and the k3s installer checks the binary's SHA-256. Agentown does not pin these.
- The runtime image is built for `linux/amd64` only.
- Turn on **branch protection** for `main` and **tag protection** (a ruleset) for `v*`. Anyone who can push a `v*` tag, or run the Release workflow on `main` (anyone with write access), can produce a validly signed release.

## Verifying a release yourself

```bash
TAG=v0.1.0
gh release download "$TAG" --repo wanatabe-yuu/Agentown

# 1) Provenance (gh must be logged in)
gh attestation verify "agentown-$TAG.tar.gz" --repo wanatabe-yuu/Agentown

# 2) Signature + checksums, exactly as install.sh does it
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/(?i:wanatabe-yuu/agentown)/\.github/workflows/release\.yml@refs/(tags/v|heads/main$)' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c SHA256SUMS
```
