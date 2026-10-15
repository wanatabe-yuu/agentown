# System chat

The **System chat** button (a gear) beside **New task** opens a private, persistent conversation for the current organization. It runs independently of agents and tasks. Closing the modal or reloading the page does not cancel the response; **Stop** cancels further generation and tools while preserving completed changes and receipts.

Choose an existing organization API key, model, effort, context budget, output limit, tool-turn limit and confirmation mode in **Settings**. A new chat starts from the organization's root agent's available key/model settings (or its first available key); these are only defaults. Saving chat settings never edits an agent. Organizations and owners have separate conversation lists and credentials.

## Least privilege: read, ask, hand off

The system chat changes nothing itself, even for the owner. Its tools:

- `inspect` and `directory`: read anything about the organization (snapshot, config, world, agents, tasks, art, audit…; `directory` is a short list of who and what is here). When reading answers the question, it just answers.
- `ask`: send a message to one agent or talking object. It goes into the owner's latest chat with them (or a new one, with their defaults), the persona answers there with its own rights, and the answer is shown in the system chat under that persona's name and avatar. Use it to talk to someone or to have them do something themselves (an agent can pet the cat).
- `assign_to_ceo`: propose work — anything that changes the world, the organization, agents, tasks or permissions — as a task for the CEO agent (the root agent), who decides who does it. It is an important action: the owner confirms the card first. The task is created by the owner, assigned to the CEO, and requires review. When it reaches review, done, failed, blocked or cancelled, a report is posted back into the system chat from whoever did it.

The organization tools the system chat used to call directly (patch/replace world, configure agents, grants…) remain the capability gateway's, used by agents within their own grants. Object personas follow the same rule: they read their own room, may change only what they themselves are doing (`set_state`) and propose work with `assign_to_ceo`; they no longer act with the owner's task permissions.

There is no host shell, arbitrary HTTP proxy, raw-key/token tool or install-level administration tool. Raw credential entry, account/token creation and binary uploads remain in the existing management UI.

## Who said it, and who was mentioned

Migration 22 adds an author to chat lines (`author_type`/`author_id`): a reply relayed by `ask` and a task report carry the agent or object they come from. Every line shows an avatar: the owner ("you"), the system chat (a gear), or the agent/object who said it. A relayed message appears in the persona's own chat as the owner speaking "via the system chat".

`chat_refs` records which conversations bring someone up: an `ask`, a hand-off to the CEO, or a line naming an agent or a named talking/acting object. That someone's chat lists those conversations ("Mentioned in…") and opens them at that conversation.

## Avatars

Each agent and placed object has a picture: an uploaded image (`world.avatars.byAgent[id].image`, `objects[].image`, PNG/JPEG/WebP from the art library) or, by default, a portrait rendered from its 3D model. Set it in the agent's Look panel or the object's Edit section. It is used in chats, conversation lists, team channels, the agent table and the 2D map.

## Objects with states

Object kinds may declare `states` (the first is the usual one; `auto` ones it drifts into by itself on a deterministic rhythm every viewer agrees on) and `actions` (put it in a state for some seconds, with a gesture: `pet`, `use` or `none`). While in a state its `behaviors` replace the kind's (a napping cat stops roaming), its glowing parts dim or brighten (`glow`) and characters show a `pose`. `POST /api/objects/:id/actions` runs an action: the owner for themself or by naming an agent, an agent only for itself and only on objects it can reach (its department's rooms, shared rooms, things that walk about). Agents have `objects` and `interact` chat tools; objects have `set_state`. Running actions are in the snapshot (`objectStates`) and stream as `org.object` events; the named agent walks over, does the gesture and walks back.

A person's workstation is its own thing: its computer is off while they are offline, asleep while they are away from the desk, on while they sit, and working while they work. Clicking the desk opens its panel.

## Context and providers

Saved key values and fragments are never returned to application owners, agents or owner assistants. The server alone decrypts keys for provider calls; runtimes authenticate to the server broker with their own Agentown identity token. Schema migration 13 removes historical key suffix metadata. Upgrading to broker-v1 replaces idle legacy runtimes and removes their provider Secrets; no provider key is present in pod/container environment.

In **Manage → API keys → Custom URL**, select **Anthropic / Claude**, a gateway root or base ending in `/v1`, and **x-api-key** to use a Claude proxy. The SDK adds `/v1/messages` without duplicating `/v1`. Bearer and other custom auth names are also supported; only the selected auth header receives the saved encrypted key. Protocol/header metadata is shared by model discovery/refresh, Owner chat and agent runtimes (schema migration 12); existing keys retain their previous defaults. Custom Claude runtimes use the standard Messages endpoint without the official provider's server-side fallback beta. Header values cannot be entered separately or read back. Existing custom keys have **Edit connection**: it reuses the encrypted key, validates models before saving, checks the credential revision, and preserves agent assignments. Connection updates are owner-only and require UI confirmation. A saved key is bound to its existing URL: changing destination requires adding a new key, so connection edits cannot forward a hidden key to another server. Connection/model authorization is rechecked on every broker request; changing protocol or model may interrupt the next request in an active task. Runtime replacement waits until idle. Owner chat includes the credential connection revision in its context signature and converts incompatible native blocks while preserving visible history.

When a custom Claude gateway returns 404/405/501 for model capabilities or token counting, Owner chat retains a labelled estimate and summary-based compaction. Configured effort is passed through when capabilities are unknown. Authentication errors are never treated as missing metadata. Native compaction remains dependent on advertised capabilities.

Anthropic uses the SDK's streamed Messages API, live Models API capabilities, supported effort/adaptive thinking and exact token counting (including system and tools). Native on-demand compaction uses the documented `compact-2026-09-04` beta when advertised by the model. The returned block and signature are preserved exactly for continuation; compaction usage is summed from `usage.iterations` without double counting top-level usage. Provider-native thinking is stored privately, never displayed as chat text.

Other configured providers use streaming OpenAI-compatible Chat Completions with function calling, output limits and final usage. OpenAI receives `reasoning_effort`; other compatible providers retain their defaults. There is no standard compatible token-count endpoint, so these contexts are explicitly labelled **estimated**. Their compaction uses a separate summary request with operational tools disabled. No native OpenAI Responses compaction is claimed.

The effective window is the smaller of the configured context budget and provider-reported input window. Output tokens are reserved before generation. Auto compact starts at 75% of the remaining input budget, between complete tool/result sequences. The next user instruction is retained verbatim. Manual compaction is also available. A failed summary preserves the original context. Inputs that still exceed the budget fail with a useful error; messages are never silently dropped.

Visible transcript and model context are separate. Compaction preserves the transcript and action receipts. Changing model/key, or deploying changed system/tool definitions, converts incompatible native blocks to portable text/calls/results so signed thinking is not reused against a different definition. Input/output/cache usage is cumulative; interrupted or unreported requests are marked as incomplete rather than represented as zero cost.

Provider errors expose a classified status rather than response bodies, authorization headers or key values. Anthropic has bounded SDK retries/timeouts; compatible transport has a timeout and supports cancellation. A context-overflow retry only retries the model call after compaction, never an already-executed write.

## Persistence and authorization

Schema migration 10 adds `owner_chats`, `owner_chat_runs`, `owner_chat_messages` and `owner_chat_actions`. Chat context/settings, transcript, partial streamed text and tool receipts are durable. A row lock and partial unique index allow one active response per chat; client request IDs deduplicate sends. Before execution each tool rechecks the owner's active account and membership, then resolves the current organization's fresh Service. Model access rechecks the selected credential and model every turn.

Actions use a durable claim before execution and a receipt after it. A process interruption between these steps is deliberately **uncertain**: recovery does not replay the write. Inspect the world before an explicit new request. Pending confirmations survive restart; interrupted generation fails with preserved history. Normal process shutdown aborts chat loops before closing the database. This runner is designed for Agentown's single server process; multiple concurrent server replicas would need worker leases and coordinated recovery.

Routes are only under `/api/orgs/:orgId/owner-chats`, require the live organization owner, return `Cache-Control: no-store`, and retain the existing same-origin cookie-write checks. Agent tokens and non-owner members (including member admins) cannot read or operate owner chat. Chats are scoped by both organization and user on every public read. An incoming modal switch pins requests to its original org path; denied polling clears its displayed state.

Migration 11 adds `archived_at`. Active and archived lists are separate; archived chats remain readable and can be restored. Sending, compaction and configuration changes require restoration first. Archive/delete are serialized with sends and refuse active responses or pending confirmations; Stop ends them first. Deletion cascades through chat messages, runs and receipts, with an explicit permanent-delete confirmation in the UI. Existing world changes/tasks are preserved. All lifecycle routes retain owner/user/org checks.

Request IDs use `crypto.getRandomValues`, which works in insecure HTTP contexts such as Tailscale HTTP Serve; they do not depend on secure-context-only `crypto.randomUUID`. This also covers task creation from an agent panel.

The browser polls durable snapshots every 900 ms while open, showing partial streamed text and reconnecting to the current response on reopen. History pages contain 100 transcript messages; the current view shows the latest 100 action receipts. The complete transcript and receipts remain in PostgreSQL. The mobile modal uses safe areas and the visual viewport for keyboard resizing, with a separate scrolling settings view.

## Validation

`owner-chat.test.ts` exercises real HTTP routes/PostgreSQL with an injected model: least privilege (no direct changes), hand-off to the CEO and its report back, owner isolation, org/key boundaries, no agent config changes, idempotency, concurrent sends, confirmations/rejections, stop/partial output, changed owner rights, native compaction/history/usage, failed summaries, tool bounds, restart uncertainty, truncated output, duplicate tool IDs, archive/restore/deletion, lifecycle isolation and concurrent lifecycle/send races. `objects.test.ts` covers object actions and reach, object/agent chat tools, the shared rhythm, `ask` relays and mention links. `apps/web/test/requestId.test.ts` covers a browser without `randomUUID`.

`chat-provider.test.ts` checks native signed-block replay, capability discovery, count/effort/thinking requests, compaction accounting and fragmented UTF-8/CRLF-compatible streaming with tool deltas and usage. Provider response bodies and malformed tool JSON cannot reach world execution.

Official protocol references: [Anthropic on-demand compaction](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand), [Models API](https://platform.claude.com/docs/en/api/models/retrieve), [OpenAI Chat Completions API](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create).

## Server-only keys and runtime broker

`POST /api/runtime/llm/anthropic/v1/messages` (including token counting) and `/api/runtime/llm/openai/v1/chat/completions` require an active agent, current generation and its configured credential/model. Human owners are refused. There is no arbitrary provider URL/path or credential selector. The server injects the saved key in the configured header and retains same-origin/org authorization. Revoked keys are refused immediately.

Provider fetch disables redirects and SDK debug logging. Incoming provider bodies are filtered across chunk boundaries before parsing or streaming; known raw and commonly encoded key values are also removed from outgoing model context, API text/exports, historical chat/log responses, SSE and terminal output. Existing keys are registered internally after server restart. This is an application permission boundary, not protection against a host/database administrator who controls the server and its encryption master key, or a trusted provider that receives authentication.

`model-broker.test.ts` checks runtime isolation, owner denial, model/protocol/generation/path checks, raw/encoded streamed echoes, hidden suffixes, immutable destinations, immediate revocation and historical API output. Native/compatible adapter tests verify identity-token transport without provider-key environment.

## Individual agent and object conversations

Each owner can open private chat with an agent or a placed world object (including cats, dogs, robots and furniture). Agent table rows and panels have Chat buttons. Table view includes an Objects & animals list; placed objects can also be clicked in the 3D office. These conversations use the existing durable chat loop, history lifecycle, token usage, compaction and important-action approval cards. Answering a question does not create a task; the persona may create concrete follow-up tasks when useful.

Migration 14 adds `subject_type`/`subject_id` to conversations and assigns stable IDs to legacy placed objects, bumping their org config revision. Every route checks owner, organization and subject. Existing owner chat remains separate. New/duplicated placements get fresh IDs; moves, labels and reorder preserve identity. Removed objects and retired agents retain readable history but cannot begin or resume work.

Default persona instructions cover colleagues/managers, cats, dogs, robots and furniture. Agent custom instructions come from its Config tab. Object kinds and individual placements have optional `chat.instructions`, editable in the world editor. Placement instructions extend the kind's instructions. These instructions do not grant authority.

Agent chat tools execute as the real agent, with grants checked again before each operation and after approval: scoped inspection, objects and interact, and task creation/assignment/retry/cancellation/review. Object personas have no execution runtime and no task tools (see Least privilege above). Agents can additionally propose `prepare_self_runtime`, bound to their own ID and the current chat’s connection/model/effort. It always requires owner confirmation and runs that specific configuration change as the freshly authorized owner. It cannot change a runtime harness, configure another agent or grant permissions. They cannot edit layout, key values or permissions. Agent chat defaults inherit the agent's key/model/effort, with available same-org department-scoped keys; object chat inherits the org manager's defaults. Saving private chat configuration does not change runtime settings; only a separately confirmed runtime-preparation action does. Keys stay server-only.

Custom Claude gateways use standard function tool schemas in the runtime rather than Anthropic's native bash extension. Optional capability/token endpoints have short timeouts and a clearly marked estimated-count fallback; authorization errors and user cancellation still fail. Native provider functionality remains available when supported.

New conversations inherit the current chat settings (credential reference, model, effort, context/output budgets, tool-turn limit and confirmation mode). History, model context and usage counters start fresh. This also applies when starting from archived history; choosing an existing conversation loads that conversation’s own saved settings.

The mobile conversation fills the available screen; settings, token details and completed tool receipts are collapsed. Pending confirmations remain visible, with readable target names and a separate details disclosure. New conversations keep the selected budgets and model settings.

Migration 15 sets the default task attempt budget to 5 and converts the original chat default of 20 model steps to 5, preserving other settings. Existing task attempts are preserved. Each reply also stops after five failed actions, including within a single batch. Reaching a chat step budget produces a `limited` response with a notice and preserved receipts, rather than a generic failure; a follow-up continues with a fresh budget. Failed/rejected/uncertain actions with the same arguments are not executed again within that response. Agent task capability guidance exposes permitted assignees/projects and readiness without secret values. Self/me aliases resolve to the actual chat subject; self-review remains forbidden.
