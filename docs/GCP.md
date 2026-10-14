# Chạy Agentown trên GCP

## Cần bao nhiêu tài nguyên

Agentown không có phần nào tính toán nặng: server, Postgres và controller chủ yếu chờ I/O. LLM chạy ở phía nhà cung cấp. Tài nguyên tăng theo **số agent đang chạy**, vì mỗi agent là một Pod có giới hạn CPU/RAM riêng (khai báo trong `runtimeCatalog`).

| Thành phần | CPU | RAM | Ghi chú |
|---|---|---|---|
| k3s control plane + hệ thống | ~0.5 | ~1 GB | |
| Postgres + server + UI | ~0.5 | ~1 GB | |
| Mỗi agent `script-v1` | 0.25 | 256 MiB | giới hạn cứng trong Pod |
| Mỗi agent `claude-v1` | 0.5 | 512 MiB | lệnh của model chạy trong máy của agent |
| Mỗi agent `claude-dedicated-v1` | 1 | 2 GiB | **chiếm nguyên một node riêng** |

Gợi ý:

| Mục đích | Máy | Sức chứa ước tính |
|---|---|---|
| Thử nghiệm | 1 × `e2-standard-2` (2 vCPU, 8 GB), đĩa 30 GB | ~5 agent script hoặc ~3 agent LLM |
| **Đề xuất cho bản thử** | 1 × `e2-standard-4` (4 vCPU, 16 GB), đĩa 50 GB `pd-balanced`, Ubuntu 24.04 | ~10 agent script hoặc ~6 agent LLM, kèm demo |
| Mỗi nhân viên “node riêng” | thêm 1 × `e2-standard-2` cho mỗi agent dedicated | 1 agent / node |

Giá on‑demand tham khảo (us-central1, chưa tính đĩa và mạng): `e2-standard-2` khoảng 50 USD/tháng, `e2-standard-4` khoảng 100 USD/tháng. Region Singapore đắt hơn một chút. Tắt VM khi không dùng thì chỉ trả tiền đĩa.

## Tạo VM

```bash
ZONE=asia-southeast1-b
gcloud compute instances create agentown-1 \
  --zone=$ZONE --machine-type=e2-standard-4 \
  --image-family=ubuntu-2404-lts-amd64 --image-project=ubuntu-os-cloud \
  --boot-disk-size=50GB --boot-disk-type=pd-balanced --tags=agentown

# Chỉ các VM Agentown nói chuyện với nhau (k3s API, flannel VXLAN, kubelet).
gcloud compute firewall-rules create agentown-internal --network=default \
  --allow=tcp:6443,udp:8472,tcp:10250 --source-tags=agentown --target-tags=agentown
```

**Không mở cổng 8080 ra Internet** (bản này chưa có TLS và đăng nhập người dùng). Mở UI qua SSH tunnel:

```bash
gcloud compute ssh agentown-1 --zone=$ZONE -- -L 8080:localhost:8080
# rồi mở http://localhost:8080 trên máy bạn
```

## Cài đặt trên VM

SSH vào VM rồi chạy một lệnh:

```bash
curl -fsSL https://agentown.site/install.sh | sudo bash
```

Script tải bản release mới nhất do GitHub Actions build, kiểm chữ ký Sigstore và checksum (xem [RELEASING.md](RELEASING.md)), cài Node 22, PostgreSQL và k3s, nạp image agent vào k3s, áp guard rails (RBAC, Pod Security, admission policy, NetworkPolicy), rồi chạy server thành service systemd `agentown`. Script cài lại được nhiều lần; chạy lại tức là nâng cấp.

| Đường dẫn | Nội dung |
|---|---|
| `/opt/agentown/current` | bản release đang chạy (giữ thêm 2 bản cũ để rollback) |
| `/etc/agentown/agentown.yaml` | cấu hình tổ chức. Chỉ tạo ở lần cài đầu, sau đó là của bạn |
| `/etc/agentown/agentown.env` | biến môi trường do installer ghi lại mỗi lần cài; thêm biến riêng vào `/etc/agentown/local.env` |
| `/var/lib/agentown` | owner token, `secret-key`, kubeconfig của controller |

```bash
sudo agentownctl token      # owner token
agentownctl status          # phiên bản, service, health
sudo agentownctl logs       # journalctl -u agentown -f
sudo agentownctl upgrade    # bản mới nhất, hoặc: upgrade v0.2.0
sudo agentownctl rollback   # quay về bản trước (không lùi schema DB)
```

Biến tuỳ chọn: `AGENTOWN_VERSION=v0.1.0` để cài một bản cố định, `AGENTOWN_DRIVER=docker` để dùng Docker thay cho k3s (ví dụ `curl -fsSL https://agentown.site/install.sh | sudo AGENTOWN_DRIVER=docker bash`).

**Sao lưu `/var/lib/agentown/secret-key`.** Các API key lưu trong DB được mã hoá bằng khoá này, mất khoá là mất key.

### Cài từ mã nguồn (để phát triển)

```bash
git clone https://github.com/wanatabe-yuu/Agentown agentown && cd agentown
sudo bash deploy/gcp/setup-vm.sh          # Docker, Node 22, pnpm, Postgres, k3s
pnpm install && pnpm build:web
sudo AGENTOWN_K3S_MODE=native scripts/dev-k3s.sh up      # image agent, guard rails, kubeconfig cho controller
sudo scripts/verify-k8s-guardrails.sh                    # RBAC + admission phải pass 18/18
AGENTOWN_K3S_MODE=native scripts/dev-server.sh           # server dùng driver kubernetes
scripts/demo.sh                                          # CEO → leader → engineer → QA chạy thật trên Pod
```

Khi chạy từ mã nguồn trong môi trường thật, đặt `AGENTOWN_SECRET_KEY` (32 byte, base64: `openssl rand -base64 32`) thay cho file khoá dev tự sinh `.agentown/secret-key`. Lưu khoá này ở nơi an toàn: mất khoá là mất các API key đã lưu.

## Thêm node (mỗi nhân viên một node)

Mỗi agent **luôn** là một Pod riêng. Nếu muốn agent có **máy riêng**, tuyển agent bằng template dùng preset `claude-dedicated-v1` (ví dụ `engineer-claude-dedicated-v1`) và thêm một VM “dedicated” cho mỗi agent như vậy:

```bash
# Trên VM server, in ra lệnh join:
sudo scripts/add-node.sh dedicated
# Tạo VM mới (cùng tag agentown) rồi chạy lệnh vừa in trên VM đó.
```

Node dedicated được gắn nhãn và taint nên chỉ Pod dedicated chạy ở đó, và mỗi node chỉ nhận một agent dedicated (pod anti‑affinity). Nếu tuyển agent dedicated khi chưa có node trống, Pod của agent sẽ ở trạng thái `pending: Unschedulable` (hiện trên UI) cho tới khi bạn thêm node. Tự động tạo VM cho mỗi lần tuyển (node autoscaling) chưa làm.

Khi có nhiều node, image agent phải có trên từng node: đẩy `agentown/harness` lên Artifact Registry và sửa `image` trong `runtimeCatalog`, đồng thời giữ danh sách image trong admission policy (tự sinh từ catalog).

## Cho một coding agent làm việc trên VM

Phiên Claude Code chạy trên cloud không SSH ra ngoài được, vì môi trường của nó chỉ cho đi HTTPS qua proxy. Hãy chạy Claude Code ngay trên VM:

```bash
sudo apt-get install -y nodejs   # đã có nếu bạn chạy install.sh
sudo npm install -g @anthropic-ai/claude-code
claude                           # trong thư mục làm việc của bạn
```

Agent đó dùng được `agentownctl status`, `sudo agentownctl logs` và `curl http://127.0.0.1:8080/healthz` để xem service.
