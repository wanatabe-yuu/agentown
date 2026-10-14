# Quyết định & giả định khi bắt đầu build

Ngày: 2026-10-14. Bối cảnh: [AGENTOWN_HANDOFF.md](./AGENTOWN_HANDOFF.md). Người dùng giao: “chọn hướng và làm”.
Các mục dưới đây là lựa chọn của lần build đầu tiên; cột **Đảo ngược?** cho biết chi phí thay đổi về sau.

## Đã chọn

| # | Vấn đề (handoff §13) | Lựa chọn | Lý do | Đảo ngược? |
|---|---|---|---|---|
| 1 | Fork hay xây mới | **Xây mới**, TypeScript monorepo (`packages/core`, `apps/server`, `apps/harness`, `apps/web`) | Lõi giá trị là mô hình quyền tách rời chức danh; các dự án tham khảo không có sẵn mô hình grant/scope này. Một ngôn ngữ cho cả server, harness, UI. | Trung bình |
| 2 | k3s hay Swarm | **k3s là đích**, có thêm **Docker driver** cho máy đơn/dev | k3s cho ServiceAccount, RBAC, Pod Security, ValidatingAdmissionPolicy, NetworkPolicy — một bức tường thứ hai độc lập với backend. Docker driver tồn tại vì sandbox build này không chạy được Pod (xem “Giới hạn môi trường”) và vì nó hữu ích cho dev. Cả hai cùng `RuntimeDriver` interface. | Dễ (driver là plugin) |
| 3 | Container hay VM | **Container** (non-root, read-only rootfs, drop ALL caps, seccomp RuntimeDefault, không token k8s) | Đủ để thử chức năng. Nếu “OS riêng” nghĩa là kernel riêng → đổi `runtimeClassName` sang gVisor/Kata trong driver k8s; không ảnh hưởng phần còn lại. | Dễ |
| 4 | Model/provider/harness | **Adapter 1: `script`** (playbook/shell, không LLM) để nghiệm thu runtime; **adapter 2: `claude`** (Anthropic SDK, tool `bash`, model mặc định `claude-opus-5-5`, bật server-side refusal fallback) | Chưa có tài khoản model trong handoff. Adapter script cho phép chứng minh vòng giao việc/quyền/khôi phục bằng tác dụng thật, không phải animation. | Dễ |
| 5 | Leader quản lý direct reports hay descendants | **Khai báo theo từng grant** trong config; fixture: exec/control = `direct-reports`, task = `team` | Handoff §5.3 luật 5: scope phải nêu rõ, không suy từ chức danh. | Dễ (sửa config) |
| 6 | CEO cấp quyền tới đâu | Chỉ **grant có cờ `delegable`** và chỉ khi **chứng minh được** scope mới nằm trong scope cha; grant được ủy quyền chết theo grant cha | Rule 3–4: spawn ≠ delegate. Fixture: CEO **không có** `runtime.exec`. | Dễ |
| 7 | Pause | Tách 3 thao tác: **pause/resume intake**, **stop/start runtime**, **cancel task** | Handoff §13. Stop runtime tăng generation → run đang chạy bị đánh dấu lost và requeue. | — |
| 8 | PO báo cáo cho ai | CEO; quyền theo **project** (`website`), không runtime.*/spawn | Handoff §13. | Dễ |
| 9 | Phong cách 2D | Top‑down, vẽ bằng Canvas 2D (không PixiJS) | Ít phụ thuộc; đủ cho MVP. | Dễ |
| 10 | Exec/SSH | **Kubernetes exec / Docker exec qua backend**, vé (ticket) dùng một lần, gắn actor + agent + generation; server đóng phiên khi quyền đổi | Đáp ứng “SSH hoặc exec” mà không cần hạ tầng SSH. | — |

## Bổ sung sau phản hồi của người dùng (2026-10-14)

| Vấn đề | Lựa chọn | Lý do |
|---|---|---|
| Một API key cho tất cả? | **Không.** Kho key do owner quản lý; mỗi agent chọn key + model mà key đó có; leader/CEO đổi được qua `agent.configure` | Người dùng muốn cấu hình riêng từng agent và chọn model theo key. Chi tiêu theo key là một quyền nên phải có action riêng và có audit. |
| Lưu key ở đâu | Postgres, mã hoá AES-256-GCM bằng `AGENTOWN_SECRET_KEY`; đưa vào Secret riêng của từng agent | Không cần thêm hệ thống secret ngay. Có thể chuyển sang KMS/Vault sau mà không đổi API. |
| “Mỗi nhân viên một Pod hoặc node riêng” | Luôn một Pod/agent; preset `placement: dedicated-node` cho agent cần máy riêng (nodeSelector + taint/toleration + anti-affinity); thêm node bằng `scripts/add-node.sh` | Giữ k3s làm điều phối (giống Swarm nhưng có RBAC/admission). Tự động tạo VM khi tuyển dụng để sau. |
| Có cần Rust không | **Chưa.** Hệ thống chủ yếu chờ I/O (DB, API Kubernetes, LLM ở xa). Phần nặng chạy trong runtime của agent, bằng ngôn ngữ của chính việc đó. | Nếu sau này có hàng nghìn agent, có thể tách riêng event gateway hoặc proxy terminal ra viết bằng Go/Rust; contract HTTP giữ nguyên. |

## Quy ước thiết kế quan trọng

- **Identity ≠ runtime.** `agentId` bền vững; Pod/container là `agent-<id>-g<generation>`. Mọi lời gọi từ harness mang `generation`; generation cũ bị từ chối (`409 stale_runtime`).
- **Scope tương đối, tính lại mỗi request** trên đồ thị báo cáo hiện tại → đổi quan hệ báo cáo là đổi quyền ngay (đã kiểm chứng: terminal đang mở bị đóng).
- **Template = gói quyền do owner duyệt** (trong `config/agentown.yaml`). `agent.spawn` liệt kê rõ template nào; agent không gửi manifest/image/mount nào.
- **Inline script = exec.** Task loại `script` chạy với danh tính và dữ liệu của người nhận, nên server yêu cầu `runtime.exec` trên người nhận. Playbook (script có sẵn trong image, tham số qua biến môi trường) chỉ cần `task.create`.
- **Chia sẻ dữ liệu có chủ đích:** agent chỉ đọc task/artifact của người khác khi task của mình tham chiếu nó (`inputTaskIds`) và người tạo task đó đã có quyền xem.
- **Run lease + idempotency key `taskId:attempt`:** mỗi attempt tối đa một run; lease hết hạn/thay runtime → `lost` → requeue có giới hạn (`max_attempts`). Không tuyên bố exactly-once cho tác dụng bên ngoài; playbook dùng idempotency key khi tạo việc/spawn.
- **Audit tách khỏi log công việc**; từ chối được ghi ngoài transaction (không bị rollback); token/secret bị lọc khỏi log, event, audit.

## Giới hạn môi trường build (trung thực)

- Sandbox build cho phép Docker và chạy được **control plane k3s**, nhưng **không chạy được Pod**: kernel cấm `oom_score_adj` âm mà kubelet luôn đặt cho pod sandbox. Việc lách giới hạn này đã bị từ chối và không được thực hiện.
- Vì vậy: phần k8s được kiểm chứng ở **API server thật** (RBAC, Pod Security, admission, và `KubernetesDriver` tạo SA/PVC/Secret/Pod thành công) nhưng **chưa thấy Pod agent chạy trên k3s**. Vòng chạy thật end‑to‑end được kiểm chứng bằng **Docker driver**.
- Adapter `claude` **chưa chạy với API thật** (chưa có key của người dùng). Vòng tool-use đã được test với một Messages API giả lập cục bộ. Server đã gọi provider thật để kiểm tra key, và key sai bị từ chối đúng.
- Lên lịch node riêng đã kiểm trên k3s thật: Pod dedicated thứ nhất được chọn vào node dedicated, Pod thứ hai bị từ chối do anti‑affinity. Pod không khởi động được do giới hạn của sandbox nói trên.

## Cần người dùng cung cấp / quyết định tiếp

1. Một máy Linux thật (hoặc VM) để chạy `AGENTOWN_K3S_MODE=native scripts/dev-k3s.sh up` và xác nhận Pod chạy trên k3s.
2. API key (thêm trong UI → API keys) nếu muốn agent LLM.
3. Mức cô lập: container (hiện tại) hay gVisor/Kata/microVM.
4. Phong cách hình ảnh văn phòng (hiện là top‑down vẽ tay đơn giản).
