import { readFileSync } from "node:fs";
import { parseOrgConfig } from "@agentown/core";
import { buildApp } from "../src/app.ts";
import { EventBus } from "../src/bus.ts";
import { createPool, migrate } from "../src/db.ts";
import { RuntimeController } from "../src/runtime/controller.ts";
import type { ExecStreams, PodInfo, RuntimeDriver, RuntimeSpec } from "../src/runtime/driver.ts";
import { llmEnv, podName } from "../src/runtime/driver.ts";
import type { ModelLister } from "../src/providers.ts";
import { SecretBox } from "../src/secrets.ts";
import { Service } from "../src/service.ts";

/** In-memory driver: pods become Ready immediately. Records issued tokens so tests can act as runtimes. */
export class FakeDriver implements RuntimeDriver {
  readonly kind = "fake";
  pods = new Map<
    string,
    PodInfo & { agentId: string; namespace: string; providerKey: string | null; providerWorkspaceId: string | null; llmEnv: Record<string, string> }
  >();
  tokens = new Map<string, string>();
  identities = new Set<string>();

  async listPods(namespace: string, agentId: string) {
    return [...this.pods.values()].filter((p) => p.agentId === agentId && p.namespace === namespace);
  }
  async ensureIdentity(spec: RuntimeSpec, issueToken: () => Promise<string>) {
    if (!this.identities.has(spec.agentId)) {
      this.tokens.set(spec.agentId, await issueToken());
      this.identities.add(spec.agentId);
    }
  }
  async createPod(spec: RuntimeSpec) {
    const name = podName(spec.agentId, spec.generation);
    this.pods.set(name, {
      name,
      agentId: spec.agentId,
      namespace: spec.namespace,
      providerKey: spec.llm?.apiKey ?? null,
      providerWorkspaceId: spec.llm?.workspaceId ?? null,
      llmEnv: spec.llm ? { ...llmEnv(spec.llm).secret, ...llmEnv(spec.llm).plain } : {},
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
  async teardown(_ns: string, agentId: string) {
    this.identities.delete(agentId);
  }
  async exec(_ns: string, _pod: string, _cmd: string[], _s: ExecStreams) {
    return { close: () => {} };
  }
}

export async function setup() {
  const url = process.env.DATABASE_URL_TEST ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown_test";
  const db = createPool(url);
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const config = parseOrgConfig(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));
  const bus = new EventBus();
  // Fake provider: keys starting with "sk-test-" are valid; the suffix picks the model set.
  // "sk-test-orgwide-" keys are not scoped to a workspace and need one named on each request.
  // OpenAI-compatible providers list "<provider>-chat"; a custom endpoint at an "/ollama" URL needs no key.
  const modelLister: ModelLister = async ({ provider, apiKey, workspaceId, baseUrl }) => {
    if (provider === "custom" && baseUrl?.endsWith("/ollama/v1")) return ["llama3.3", "qwen3"];
    if (!apiKey.startsWith("sk-test-")) throw new Error("401 invalid x-api-key");
    if (provider !== "anthropic") return [`${provider}-chat`, `${provider}-mini`];
    if (apiKey.startsWith("sk-test-orgwide-") && !workspaceId) {
      throw new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header"}}');
    }
    return apiKey.includes("small") ? ["claude-haiku-5-5"] : ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
  };
  const service = new Service(db, config, bus, SecretBox.forTests(), modelLister);
  const { ownerToken } = await service.bootstrap();
  const driver = new FakeDriver();
  const controller = new RuntimeController(service, driver, { apiUrlForRuntimes: "http://test" });
  const { app, recheckTerminals } = await buildApp({ service, driver });
  // Two passes: create pods, then observe them Ready.
  const settle = async () => {
    await controller.reconcileAll();
    await controller.reconcileAll();
  };
  await settle();

  const call = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await app.inject({
      method: method as "GET",
      url,
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
    service,
    driver,
    controller,
    settle,
    app,
    recheckTerminals,
    owner: ownerToken!,
    token: (agentId: string) => {
      const t = driver.tokens.get(agentId);
      if (!t) throw new Error(`no token for ${agentId}`);
      return t;
    },
    call,
    async close() {
      await app.close();
      await db.end();
    },
  };
}
