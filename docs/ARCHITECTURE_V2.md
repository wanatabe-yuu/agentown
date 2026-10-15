# Agentown v2 — Kiến trúc Team Runtime

Trạng thái: **đã triển khai** Team runtime, Hội thoại, Proposal Engine và Capability System (mục 0). World Kernel (P0) vẫn là thiết kế: quyền, danh tính và tài nguyên hiện vẫn nằm trong `Service`.

## 0. Đã triển khai

| Phần | Cách làm | Code |
|---|---|---|
| Team trong org | `teams: [{id, name, department, runtimePreset?}]` trong tài liệu org. Department nào chưa có team cùng id thì có team mặc định (id = department). Agent có `team_id` (NULL = team mặc định). Team còn người thì không xoá được. | `packages/core/src/config.ts` (`teamsOf`), migration 18 |
| 1 runtime / team | Controller dựng một pod cho mỗi team (`team_runtimes`). Pod cũ theo từng agent tự được dọn, nhưng chỉ khi agent đó đang không chạy task. | `apps/server/src/runtime/controller.ts` |
| Member trong runtime | Supervisor (`apps/harness/src/supervisor.ts`) hỏi `GET /api/runtime/team` (token của runtime) rồi chạy mỗi member thành một tiến trình riêng. Mỗi member có token phiên riêng (`POST /api/runtime/team/members/:id/session`), HOME, memory `/workspace/members/<id>`, kết nối model và instruction riêng. Thư mục chung là `/workspace/shared`. | `apps/harness/src/member.ts` (harness cũ) |
| Scale theo người | Kích thước pod = phần nền của preset (`resources`) + tổng phần khai báo của các member đang chạy (`member` là mặc định). Người thêm member khai báo `resources: {cpu, memory}`; đổi sau qua `PUT /agents/:id/resources` (cần `runtime.control`). | `Service.teamPlans`, `setResources` |
| Scale có restart không | **Có, nhưng không làm mất việc.** k3s 1.30 không đổi tài nguyên pod tại chỗ, nên đổi kích thước là một thế hệ runtime mới, và chỉ thực hiện khi team không còn run nào đang chạy. Trong lúc chờ, member mới đã chạy ngay trong pod hiện tại (supervisor tự nhận). UI hiện "resize … after current work". | `controller.reconcile` |
| Đổi một member | Stop/restart, đổi key hay chuyển team chỉ bump generation **của member đó**: supervisor dừng rồi khởi động lại đúng tiến trình đó, pod của team giữ nguyên. | `refreshMemberConnection`, `setTeam` |
| Hội thoại | Side panel có khu **Hội thoại** với dropdown: **Bạn** (chat riêng với người/đồ vật), **Team** (kênh `team_messages` + hoạt động của team; agent dùng `agentown team say`), **Khác** (Tự hỏi, Đề xuất, Tool, Sự kiện từ `GET /feed`). | `apps/web/src/Conversations.tsx`, `apps/server/src/conversations.ts` |
| Giao diện | Văn phòng 3D (three.js) là mặc định trên mọi màn hình. | `apps/web/src/App.tsx` |
| Proposal Engine | Bảng `proposals` (migration 19): kind, proposer, subject, payload, `source` (bản ghi gốc, duy nhất), status, evaluation, approvers, decisions, receipt. Phần code sở hữu thay đổi tự mở và đóng proposal: hành động chat chờ duyệt (`chat_action`), kết quả chờ review (`task`), đổi cấu hình (`agent_config`, ghi luôn trạng thái applied kèm receipt), gọi qua gateway (`gateway`). Quyết định qua `POST /proposals/:id/decide`; handler của từng nguồn kiểm quyền và thực hiện, nên duyệt ở chat, ở review hay ở hộp Đề xuất đều cho cùng một kết quả. | `apps/server/src/proposals.ts` |
| Capability System | **Registry**: 17 tool tổ chức (cùng thao tác Service mà UI dùng), `team_say`, `bash` (runtime-local). **Discovery**: `GET /tools` chỉ trả tool mà người gọi có quyền, kèm JSON Schema. **Gateway**: `POST /tools/:id/invoke` validate → kiểm quyền → hỏi quy tắc duyệt → chạy → audit. Lệnh quan trọng của người không phải owner thành proposal `pending` (HTTP 202); owner duyệt thì lệnh chạy với quyền của người đề xuất. Agent dùng `agentown tools` / `agentown tool ID '{…}'` / `agentown proposals`. Không phụ thuộc runtime nào. | `apps/server/src/capabilities.ts` |
| Duyệt trong UI | Khác → Đề xuất đọc từ `proposals`, có nút Duyệt / Từ chối cho người được quyết định. | `apps/web/src/Conversations.tsx` |
| Cập nhật image | `node server/tools/roll-runtimes.mjs` thay runtime của mọi team đang rảnh (team đang bận được bỏ qua). | `apps/server/src/tools/roll-runtimes.ts` |

Giới hạn hiện tại:
- Workspace cũ của từng agent không được copy sang workspace của team: PVC cũ vẫn còn, chỉ không còn được mount.
- Member trong cùng team tin nhau: cùng uid, đọc được file của nhau. Cần cô lập thật thì cho người đó làm team riêng.

Thay cho mô hình "1 agent = 1 pod" trước đây.

## Vì sao đổi

- Hiện tại mỗi agent có pod, ServiceAccount, PVC, Secret và generation riêng (`apps/server/src/runtime/driver.ts`). 18 agent × 0.5 CPU = 9 CPU; VM 4 vCPU chỉ chạy được ~7.
- Agent cùng phòng ban dùng chung môi trường (tool, repo, image) nhưng vẫn bị nhân bản toàn bộ hạ tầng.
- Quyền, tool, phê duyệt nằm rải rác: `policy.ts`, `chat/tools.ts`, `owner_chat_actions`, `tasks.requires_review`, receipt `configChange`. Không có một nơi duy nhất để thêm tool hay quy trình duyệt.
- Kubernetes rò vào core: `namespace`, `workload_ref`, `storage_ref`, `PodInfo.phase`, `namespaceFor(dept)`, terminal `{namespace, pod}`.

## Tổng quan 5 khối

```
                ┌──────────────────────────────────────────────┐
                │ World Interface (web: văn phòng 2D/3D,        │
                │ quan sát, hộp duyệt, quản lý team/member)     │
                └───────────────┬──────────────────────────────┘
                                │ HTTP + event stream
┌───────────────────────────────▼──────────────────────────────────┐
│ World Kernel: Luật nền tảng · Danh tính · Tài nguyên · Quyền      │
│  ├─ Capability System: Registry · Discovery · Gateway             │
│  └─ Proposal & Approval Engine                                    │
└───────────────▲──────────────────────────────────▲───────────────┘
                │ Runtime Protocol (HTTP/MCP)       │ RuntimeProvider port
┌───────────────┴──────────────┐         ┌──────────┴──────────────┐
│ Agent Runtime (1 / team)     │◄────────│ Adapter: k8s | docker | │
│ supervisor + N member        │ tạo/huỷ │ Scion | fake | ...      │
└──────────────────────────────┘         └─────────────────────────┘
```

Quy tắc phụ thuộc: **Kernel, Capability, Proposal không import gì từ runtime.** Runtime chỉ biết Runtime Protocol. Adapter chỉ biết `RuntimeProvider`. Đổi Kubernetes sang Scion hay runtime khác thì viết một adapter mới, không đụng phần còn lại.

## 1. Mô hình tổ chức mới

| Khái niệm | Nghĩa | Có runtime? |
|---|---|---|
| Organization (world) | Một thế giới, như `coffee` | Không |
| Department | Nhóm quản trị, phạm vi quyền (như IT) | Không |
| **Team** (mới) | Đơn vị làm việc trong department, **dùng chung một runtime** | **1 runtime / team** |
| **Member** | Một "người" (agent) trong team: danh tính, instruction, memory, kết nối model, session chat riêng | Chạy bên trong runtime của team |
| Object | Vật thể trong world (máy pha cà phê, tủ hồ sơ...) | Không, nếu không cần môi trường |
| Room | Chỉ là hiển thị trong văn phòng | Không |

- Department IT có thể có team `it-ops`, `it-dev`. Hai team là hai runtime; các member trong `it-dev` dùng chung image, tool, workspace, CPU.
- Ví dụ coffee: 7 agent → 2 team (`front`, `roastery`) → 2 runtime thay vì 7.
- **Object không cần môi trường** (chat theo instruction, trả lời câu hỏi, gọi tool qua gateway) gom vào **Commons**: chạy ngay trong server process, không có pod. Đây là cách object chat đang chạy hôm nay (`chat/subjects.ts`), chỉ đổi tên và đưa về đúng chỗ.
- Object/member **cần môi trường** (bash, file, repo, build) phải thuộc một team có runtime.

## 2. World Kernel

Nguồn sự thật duy nhất. Thuần dữ liệu + quy tắc, không biết runtime tồn tại thế nào.

| Thành phần | Nội dung | Từ code hiện tại |
|---|---|---|
| **Luật nền tảng (Rules)** | Org config, cấu trúc department/team, task state machine, giới hạn (max attempts, context budget, quota CPU theo team) | `organizations.config`, `packages/core/src/config.ts`, `tasks.ts` |
| **Danh tính (Identity)** | Principal: `user`, `member`, `object`, `runtime`. Token, membership (member ∈ team ∈ department) | `users`, `org_members`, `tokens`, `agents` |
| **Tài nguyên (Resources)** | Credential (key mã hoá), asset, workspace, runtime preset, quota | `credentials`, `assets`, `runtimeCatalog` |
| **Quyền (Permissions)** | Grant, scope, delegation, `authorize()` | `packages/core/src/policy.ts`, `grants` |

Thay đổi:
- Principal mới `runtime:<teamRuntimeId>`. Runtime **không** tự có quyền nghiệp vụ; nó chỉ được xin **member session** cho member thuộc team mình.
- Scope mới `team`. Scope `team` hiện tại (nghĩa là "bản thân + cấp dưới", `policy.ts`) đổi tên thành `subtree` để tránh trùng với Team mới.
- Credential có thể giới hạn theo `teams[]` ngoài `departments[]`.

## 3. Agent Runtime (team runtime)

Một môi trường cô lập cho một team. Bên trong là **supervisor** (thay harness hiện tại) quản lý N member.

```
/workspace/shared/                 # repo, file chung của team
/workspace/members/<memberId>/     # home riêng: memory/, sessions/, tasks/
```

Mỗi member có riêng:
- **Instruction, model, effort, contextLimit**: nhận khi claim task (đã có `config_snapshot`).
- **Kết nối**: credential/model riêng qua model broker. Key không bao giờ vào pod (đã có); broker kiểm theo **member** chứ không theo pod.
- **Memory**: lưu server-side (`member_memory`: ghi chú bền, tóm tắt các lần chạy), cache ở `members/<id>/memory/`. Runtime bị huỷ thì memory vẫn còn.
- **Session chat**: entity chat hiện tại trở thành session của member. Chat riêng của owner vẫn private với runtime.

Supervisor:
- Một lease/heartbeat cho cả runtime. Claim theo member: `POST /api/runtime/claim {member}`.
- Chạy song song tối đa `team.concurrency` member, mặc định 2, để CPU của team không bị một member chiếm hết.
- Mỗi lệnh bash chạy với `HOME=/workspace/members/<id>` và cwd của task đó.

**Fencing:**
- `generation` giờ thuộc **runtime của team**. Huỷ hoặc tạo lại runtime sẽ đánh dấu mọi run của team là `lost`, như hiện nay.
- Đổi cấu hình **một member** (model, key, instruction) **không** restart runtime. Chỉ tăng `member.epoch`; task sau sẽ nhận cấu hình mới. Hiện tại đổi credential là bump generation và restart pod, điều đó sẽ không còn.

**Đánh đổi cần chấp nhận:** các member trong cùng team chạy chung uid nên đọc được file của nhau. Ranh giới tin cậy là **team**, không phải member. Secret vẫn an toàn vì không bao giờ vào pod. Member nào cần cô lập thật thì cho làm team riêng một người (tương đương preset `dedicated` hôm nay).

### RuntimeProvider port (trung lập với hạ tầng)

```ts
interface RuntimeProvider {
  readonly kind: string;                           // "kubernetes" | "docker" | "scion" | "fake"
  provision(spec: TeamRuntimeSpec): Promise<RuntimeRef>;   // idempotent
  observe(ref: RuntimeRef): Promise<RuntimeStatus>;
  retire(ref: RuntimeRef, opts: { purgeWorkspace: boolean }): Promise<void>;
  openShell?(ref: RuntimeRef, streams: ShellStreams, opts?: { member?: string }): Promise<{ close(): void }>;
}

type RuntimeRef = { provider: string; id: string };      // opaque với core
type RuntimeStatus =
  | { state: "starting" | "ready" | "degraded"; detail?: string }
  | { state: "failed"; detail: string; retryable: boolean }
  | { state: "gone" };

interface TeamRuntimeSpec {
  teamId: string; orgId: string; generation: number;
  preset: { image: string; cpu: string; memory: string; workspaceSize: string; isolation: "shared" | "dedicated" };
  apiUrl: string;            // Runtime Protocol endpoint
  bootstrapToken: () => Promise<string>;   // runtime principal token
}
```

- Namespace, pod, PVC, ServiceAccount, NetworkPolicy, FATAL_WAITING... tất cả nằm **trong** adapter Kubernetes.
- DB lưu `runtime_ref jsonb`, thay cho các cột `namespace`, `workload_ref`, `storage_ref`.
- Controller chỉ còn so desired/observed qua `RuntimeStatus`, không biết pod phase.

### Runtime Protocol

API duy nhất mà một runtime dùng. Mọi runtime (k8s, Scion, local) nói cùng giao thức này:

| Endpoint | Việc |
|---|---|
| `POST /api/runtime/hello` | runtime token → danh sách member của team, generation |
| `POST /api/runtime/heartbeat` | trạng thái runtime + trạng thái từng member |
| `POST /api/runtime/members/:id/session` | đổi runtime token lấy **member token ngắn hạn** (Kernel kiểm member ∈ team) |
| `POST /api/runtime/claim` | claim task cho một member |
| `/api/capabilities/*` | gọi tool qua Gateway, dùng member token |
| `/api/runtime/llm/*` | model broker, dùng member token |

Có thể bọc lại thành MCP server để runtime bên thứ ba dùng tool của Agentown mà không cần SDK riêng.

## 4. Capability System

Độc lập với runtime. Một tool được định nghĩa **một lần** và dùng được từ: member trong runtime, chat của owner, chat của object (Commons), runtime bên thứ ba qua MCP.

### Tool Registry

```ts
interface CapabilityDescriptor {
  id: string;                       // "task.create", "world.patch", "repo.propose_change"
  version: number;
  title: string; description: string;
  input: ZodSchema; output?: ZodSchema;
  permission: Action;               // action của Kernel phải pass
  effect: "read" | "write" | "external" | "destructive";
  approval: "never" | "policy" | "always";     // Proposal Engine quyết khi "policy"
  executor: string;                 // "kernel" | "runtime-local" | "http:<url>" | "mcp:<server>"
}
```

- Đưa các tool đang có thành descriptor: `chat/tools.ts` (17 tool), `subjects.ts`, các lệnh của CLI `agentown`.
- `bash` là capability `runtime-local`: thực thi trong runtime, nhưng vẫn khai báo trong registry để Discovery và quyền biết đến nó.
- Tool ngoài (MCP server, HTTP) đăng ký vào registry với `executor: mcp:...`.

### Discovery

`GET /api/capabilities?for=<principal>` trả về các tool principal đó **được phép** dùng, kèm schema. System prompt của member và chat sinh từ đây, không hard-code nữa (hiện tại hard-code ở `common.ts` và `chat-persona.ts`).

### Gateway

Một cửa duy nhất: `POST /api/capabilities/:id/invoke`

1. Xác thực principal (member token, user, object).
2. Validate input theo schema.
3. `Kernel.authorize(principal, descriptor.permission, target)`.
4. Hỏi Proposal Engine: cần duyệt không? Nếu cần, tạo proposal và trả `202 {proposalId}`.
5. Thực thi qua executor, ghi audit và receipt.

Rate limit, idempotency key, redact secret đều đặt ở đây.

### Permissions

Không có hệ quyền thứ hai. Gateway dùng đúng `authorize()` của Kernel. Grant có thể thêm constraint `capabilities[]` để giới hạn theo tool cụ thể.

## 5. Proposal & Approval Engine

Một cơ chế cho mọi thứ cần "đề xuất, đánh giá, phê duyệt". Không phụ thuộc chat hay runtime.

```ts
interface Proposal {
  id: string; orgId: string;
  kind: "capability_call" | "config_change" | "world_change" | "permission_change"
      | "task_result" | "runtime_change" | "team_change";
  proposer: Principal;            // member, user, object, system
  subject: { type: string; id: string };   // thứ bị thay đổi
  payload: unknown;               // input của tool / patch / diff
  baseRevision?: number;          // chống ghi đè (optimistic)
  status: "pending" | "approved" | "rejected" | "applying" | "applied" | "failed" | "expired" | "withdrawn";
  evaluation: { rule: string; verdict: "allow" | "require_approval" | "deny"; reason: string }[];
  approvers: ApproverRule;        // owner | role | manager-of(subject) | n-of-m
  decisions: { by: Principal; verdict: "approve" | "reject"; note?: string; at: string }[];
  receipt?: { before: unknown; after: unknown; changedFields: string[]; revision: number };
  expiresAt?: string;
}
```

Luồng: **propose → evaluate** (quy tắc tự động: effect, scope, chi phí, giờ làm) **→ pending → decide → apply → receipt**.

Gộp các thứ hiện có:

| Hiện tại | Trở thành |
|---|---|
| `owner_chat_actions` pending/approved/applying | `capability_call` |
| `tasks.requires_review` + `reviewTask` | `task_result` |
| `configChange` receipt + `agent.configured` | `config_change` (receipt nằm trên proposal) |
| `prepare_self_runtime` | `runtime_change` |
| `code.propose` (đang chưa có endpoint) | `capability_call` của `repo.propose_change` |

Engine chỉ gọi lại Capability Gateway để apply, nên không biết runtime là gì.

## 6. World Interface

- **Văn phòng 3D** (three.js) là mặc định; bảng (Table) là chế độ phụ.
- Hiển thị theo Department → Team → Member, kèm trạng thái và kích thước runtime của team.
- **Hội thoại**: một khu duy nhất, dropdown Bạn / Team / Khác. Proposal nằm trong Khác → Đề xuất.
- **Quan sát**: event stream sẵn có, cộng thêm sự kiện runtime và proposal.
- **Quản lý**: tạo, tách, gộp team; chuyển member giữa team; xem memory member; tool đang bật của từng member (từ Discovery).

## 7. Kế hoạch chuyển đổi

Mỗi giai đoạn đều chạy được và test được độc lập. Thứ tự đặt Capability và Proposal **trước** Team Runtime, vì đó là hai khối phải độc lập.

| Giai đoạn | Việc | Kết quả kiểm tra |
|---|---|---|
| **P0 Kernel** | Gom identity, quyền, tài nguyên, luật vào `apps/server/src/kernel/`; `Service` gọi qua đó. Không đổi hành vi. | `pnpm check` xanh, không đổi API |
| **P1 Proposal Engine** | Bảng `proposals`; chuyển `owner_chat_actions`, task review, config receipt sang | Test hiện có của chat và review vẫn pass trên engine mới |
| **P2 Capability System** | Registry + Discovery + Gateway; tool chat và lệnh CLI thành descriptor; CLI `agentown` gọi Gateway | Một tool định nghĩa một lần, dùng được ở chat và runtime |
| **P3 RuntimeProvider** | Interface trung lập; k8s, docker, fake thành adapter; `runtime_ref jsonb` thay 3 cột k8s | Không còn chữ `namespace`/`pod` ngoài `runtime/adapters/*` |
| **P4 Team Runtime** | Bảng `teams`, `agents.team_id`, `member_memory`, `member.epoch`; supervisor đa member; Runtime Protocol | 7 agent coffee chạy trong 2 runtime trên VM 4 vCPU |
| **P5 World Interface** | Văn phòng 2D, hộp duyệt, quản lý team | Duyệt proposal và tách team được từ điện thoại |

Migrate dữ liệu ở P4:
- Mỗi department tạo một team mặc định `<dept>-core`; agent thành member của team đó.
- Copy PVC từng agent vào `/workspace/members/<id>/`.
- Owner có thể tách team sau.

## 8. Đã chốt

1. Không chỉ dùng hộp duyệt riêng: mọi hội thoại vào một khu có bộ lọc Bạn / Team / Khác.
2. Runtime = 1 team, scale theo số người và tài nguyên mỗi người khai báo. Mọi member chạy song song.
3. Team là một phần trong cấu trúc org. Scope `team` cũ (bản thân + cấp dưới) giữ nguyên tên để không phá grant đã cấp.
4. Văn phòng 3D (three.js) là mặc định.
5. Làm Team runtime (P3/P4) trước để giải quyết CPU; Kernel, Proposal và Capability làm sau.
