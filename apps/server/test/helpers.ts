import { readFileSync } from "node:fs";
import { type AppOptions, buildApp } from "../src/app.ts";
import { EventBus } from "../src/bus.ts";
import { createPool, migrate } from "../src/db.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import type { ExecStreams, PodInfo, RuntimeDriver, RuntimeSpec } from "../src/runtime/driver.ts";
import { podName } from "../src/runtime/driver.ts";
import type { ModelLister } from "../src/providers.ts";
import { SecretBox } from "../src/secrets.ts";
import { Instance } from "../src/instance.ts";
import type { ChatModelFactory } from "../src/chat/types.ts";

/** In-memory driver: pods become Ready immediately. Records issued runtime tokens. */
export class FakeDriver implements RuntimeDriver {
  readonly kind = "fake";
  pods = new Map<string, PodInfo & { runtimeId: string; teamId: string; namespace: string; resources: { cpu: string; memory: string }; env: Record<string, string> }>();
  tokens = new Map<string, string>();
  identities = new Set<string>();

  async listPods(namespace: string, runtimeId: string) {
    return [...this.pods.values()].filter((p) => p.runtimeId === runtimeId && p.namespace === namespace);
  }
  async ensureIdentity(spec: RuntimeSpec, issueToken: () => Promise<string>) {
    if (!this.identities.has(spec.runtimeId)) {
      this.tokens.set(spec.runtimeId, await issueToken());
      this.identities.add(spec.runtimeId);
    }
  }
  async createPod(spec: RuntimeSpec) {
    const name = podName(spec.runtimeId, spec.generation);
    this.pods.set(name, {
      name,
      runtimeId: spec.runtimeId,
      teamId: spec.teamId,
      namespace: spec.namespace,
      resources: spec.resources,
      env: { AGENTOWN_TEAM_ID: spec.teamId, AGENTOWN_HARNESS: spec.preset.harness },
      generation: spec.generation,
      phase: "Running",
      ready: true,
      terminating: false,
      restarts: 0,
      waitingReason: null,
      message: null,
    });
    return name;
  }
  async deletePod(_ns: string, name: string) {
    this.pods.delete(name);
  }
  async teardown(_ns: string, runtimeId: string) {
    this.identities.delete(runtimeId);
  }
  async exec(_ns: string, _pod: string, _cmd: string[], _s: ExecStreams) {
    return { close: () => {} };
  }
}

const AGENT_TOKEN = "test-agent-session:";

export async function setup(chatModelFactory?: ChatModelFactory, extra?: Partial<AppOptions>) {
  const url = process.env.DATABASE_URL_TEST ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown_test";
  const db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const configText = readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8");
  const bus = new EventBus();
  // Fake provider: keys starting with "sk-test-" are valid; the suffix picks the model set.
  // "sk-test-orgwide-" keys are not scoped to a workspace and need one named on each request.
  // OpenAI-compatible providers list "<provider>-chat"; a custom endpoint at an "/ollama" URL needs no key.
  const modelLister: ModelLister = async ({ provider, apiKey, workspaceId, baseUrl, protocol }) => {
    if (provider === "custom" && baseUrl?.endsWith("/ollama/v1")) return ["llama3.3", "qwen3"];
    if (!apiKey.startsWith("sk-test-")) throw new Error("401 invalid x-api-key");
    if (provider !== "anthropic" && protocol !== "anthropic") return [`${provider}-chat`, `${provider}-mini`];
    if (apiKey.startsWith("sk-test-orgwide-") && !workspaceId) {
      throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}');
    }
    return apiKey.includes("small") ? ["claude-haiku-5-5"] : ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  };
  const instance = new Instance(db, configText, bus, SecretBox.forTests(), modelLister, new URL("../../../config/templates", import.meta.url).pathname);
  const { ownerToken } = await instance.bootstrap();
  const service = await instance.org(instance.defaultOrgId);
  const driver = new FakeDriver();
  const controller = new RuntimeController(instance, driver, { apiUrlForRuntimes: "http://test" });
  const { app, recheckTerminals, ownerChat } = await buildApp({ instance, driver, chatModelFactory, ...extra });
  // Two passes: create pods, then observe them Ready.
  const settle = async () => {
    await controller.reconcileAll();
    await controller.reconcileAll();
  };
  await settle();
  const memberTokens = new Map<string, string>();
  const member = async (agentId: string) => {
    if (!memberTokens.has(agentId)) memberTokens.set(agentId, await service.issueToken(db, "agent", agentId, "test session", false));
    return memberTokens.get(agentId)!;
  };

  // People act inside an organization: tests written against /api/… run in the default one.
  const INSTANCE_ROUTES = /^\/api\/(session|orgs\/|admin\/|admin$|templates|instance\/)/;
  const call = async (token: string, method: string, url: string, body?: unknown) => {
    if (token.startsWith(AGENT_TOKEN)) token = await member(token.slice(AGENT_TOKEN.length));
    // Prompt tasks need an agent with an API key; tests about task flow use a model-free playbook unless they say otherwise.
    if (method === "POST" && /^\/api\/(orgs\/[^/]+\/)?tasks$/.test(url) && body && !(body as { spec?: unknown }).spec) body = { ...(body as object), spec: { kind: "playbook", playbook: "noop", args: {} } };
    const res = await app.inject({
      method: method as "GET",
      url: url.startsWith("/api/") && !INSTANCE_ROUTES.test(url) ? `/api/orgs/${instance.defaultOrgId}/${url.slice(5)}` : url,
      headers: { authorization: `Bearer ${token}` },
      ...(body !== undefined ? { payload: body as object } : {}),
    });
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, body: json };
  };

  return {
    db,
    instance,
    service,
    driver,
    controller,
    settle,
    app,
    recheckTerminals,
    ownerChat,
    owner: ownerToken!,
    /**
     * An agent's session token, as its team runtime would get it (one per agent per test).
     * `call` resolves it; for raw app.inject use `await env.member(id)`.
     */
    token: (agentId: string) => `${AGENT_TOKEN}${agentId}`,
    member,
    /** The runtime pod of an agent's team. */
    teamPod: async (agentId: string) => {
      const { rows } = await db.query("SELECT r.runtime_id, r.generation FROM team_runtimes r JOIN agents a ON a.org_id=r.org_id AND COALESCE(a.team_id, a.department_id)=r.team_id WHERE a.id=$1", [agentId]);
      return rows[0] ? driver.pods.get(podName(rows[0].runtime_id, rows[0].generation)) : undefined;
    },
    call,
    async close() {
      await app.close();
      await db.end();
    },
  };
}
