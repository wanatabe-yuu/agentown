# Phát hành và chuỗi cung ứng

## Ra một bản release

1. Đặt version mới ở `package.json` (root) và ở `image:` trong `runtimeCatalog` của `config/agentown.yaml`. `scripts/package-release.sh` dừng lại nếu một trong hai không khớp với tag. Sửa luôn tag image trong script `image` của `apps/harness/package.json` và trong `scripts/dev-k3s.sh`, vì lúc dev hai chỗ đó vẫn dùng tag cũ.
2. Merge vào `main`, rồi đẩy tag:
   ```bash
   git tag v0.1.0 && git push origin v0.1.0
   ```
3. Workflow `.github/workflows/release.yml` chạy test, build, ký, rồi tạo GitHub Release với các file:

| File | Nội dung |
|---|---|
| `agentown-<tag>.tar.gz` | server đã bundle (`server/main.mjs`), web UI, `config/agentown.yaml`, `install.sh`, `bin/agentownctl` |
| `agentown-harness-<tag>-amd64.tar.gz` | image runtime agent (`docker save`), được nạp thẳng vào containerd của k3s hoặc Docker |
| `agentown-<tag>.sbom.cdx.json` | SBOM CycloneDX của repo (theo lockfile) |
| `SHA256SUMS` | checksum của mọi file trên |
| `SHA256SUMS.sigstore.json` | chữ ký Sigstore keyless của `SHA256SUMS` |

Máy chủ cài hoặc nâng cấp bằng `curl -fsSL https://agentown.site/install.sh | sudo bash`, hoặc `sudo agentownctl upgrade`. Xem [GCP.md](GCP.md).

Thử build release trên máy mình: `scripts/package-release.sh v0.1.0 out/`, cần Docker. Bỏ qua bước build image bằng `AGENTOWN_SKIP_IMAGE=1`.

## Chuỗi cung ứng: cái gì bảo vệ cái gì

| Rủi ro | Biện pháp |
|---|---|
| File release bị tráo trên đường tải hoặc trên GitHub | `install.sh` kiểm chữ ký Sigstore của `SHA256SUMS`. Chứng chỉ phải do GitHub Actions OIDC cấp cho **đúng** `wanatabe-yuu/Agentown/.github/workflows/release.yml` chạy từ một tag `v*`. Sau đó mới kiểm `sha256sum` từng file. Sai bất kỳ bước nào là dừng, không cài. |
| Công cụ kiểm chữ ký bị tráo | `install.sh` pin `cosign` theo phiên bản và SHA-256. |
| Không biết bản build từ commit nào | Mỗi file có attestation SLSA build provenance (`actions/attest-build-provenance`), ghi lại repo, commit, workflow và runner. `VERSION` trong tarball ghi commit. |
| Action bên thứ ba bị chiếm quyền rồi đổi tag | Mọi GitHub Action được pin theo commit SHA (tag ghi ở comment). Dependabot mở PR khi có bản mới. |
| Image gốc `node:22-alpine` bị đổi | `apps/harness/Dockerfile` pin theo digest. Dependabot (ecosystem `docker`) bump digest. |
| Phụ thuộc npm thay đổi ngầm | `pnpm install --frozen-lockfile` ở CI và release. Chỉ `esbuild` được chạy postinstall (`onlyBuiltDependencies`). |
| Cache CI bị đầu độc rồi lọt vào bản ký | Job release không dùng cache dependency. |
| Token của workflow bị lạm dụng | Quyền mặc định `contents: read`. Chỉ job release có `contents: write`, `id-token: write`, `attestations: write`. `actions/checkout` chạy với `persist-credentials: false`. |
| Biết bản release chứa những gì | SBOM CycloneDX đi kèm, nằm trong `SHA256SUMS` nên cũng được ký. |

Còn hở, cần biết:

- `curl … install.sh | sudo bash` tin vào TLS và vào trang `agentown.site` (GitHub Pages, build từ `main`). Ai cần chặt hơn thì tải `install.sh` từ trang Release, kiểm chữ ký như dưới đây rồi mới chạy. Từ lần cài thứ hai, `agentownctl upgrade` dùng `install.sh` nằm trong bản đã kiểm, không tải lại từ trang web.
- NodeSource, Docker và k3s được cài theo kênh chính thức của họ: apt có ký GPG, và installer của k3s kiểm SHA-256 của binary. Agentown không pin các phần này.
- Image runtime chỉ build cho `linux/amd64`.
- Nên bật **branch protection** cho `main` và **tag protection** (ruleset) cho `v*`: ai đẩy được tag là ra được bản release có chữ ký hợp lệ.

## Tự kiểm một bản release

```bash
TAG=v0.1.0
gh release download "$TAG" --repo wanatabe-yuu/Agentown

# 1) Provenance (cần gh đã đăng nhập)
gh attestation verify "agentown-$TAG.tar.gz" --repo wanatabe-yuu/Agentown

# 2) Chữ ký + checksum, đúng như install.sh làm
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/wanatabe-yuu/Agentown/\.github/workflows/release\.yml@refs/tags/v' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
sha256sum -c SHA256SUMS
```

## agentown.site

Workflow `.github/workflows/site.yml` đẩy thư mục `site/` cùng `deploy/install.sh` (thành `/install.sh`) lên GitHub Pages mỗi khi chúng đổi trên `main`. Thiết lập một lần:

1. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. **Settings → Pages → Custom domain**: `agentown.site`, rồi bật **Enforce HTTPS** khi chứng chỉ đã cấp xong.
3. DNS của `agentown.site` ở nhà đăng ký tên miền:
   - `A @` → `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - `AAAA @` → `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`
   - `CNAME www` → `wanatabe-yuu.github.io`
4. Nên **xác minh domain** trong Settings của tài khoản GitHub (Pages → Verified domains) để người khác không chiếm được `agentown.site` trên Pages.
