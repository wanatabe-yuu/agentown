import { Readable } from "node:stream";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { Actor } from "@agentown/core";
import { anthropicBaseUrl, keyHeaders } from "@agentown/core";
import type { Service } from "./service.ts";
import { badRequest, deny } from "./util.ts";
import { providerFetch } from "./key-redaction.ts";

/** Authenticated runtime model transport. No key endpoint, arbitrary URL or credential selector. */
export async function forwardModel(service: Service, actor: Actor, req: FastifyRequest, reply: FastifyReply, protocol: string, path: string) {
  if (actor.kind !== "agent") throw deny("Only agent runtimes can call the model broker.");
  const generation = Number(req.headers["x-agentown-generation"]);
  if (!Number.isSafeInteger(generation) || generation < 1) throw badRequest("Missing runtime generation.");
  const target = await service.runtimeProviderTarget(actor, generation);
  if (protocol !== target.protocol) throw badRequest("Protocol does not match this runtime's credential.");
  const body = req.body as Record<string, unknown> | undefined;
  const allowed = protocol === "anthropic" ? ["v1/messages", "v1/messages/count_tokens"] : ["v1/chat/completions"];
  if (req.method !== "POST" || !allowed.includes(path)) throw deny("This provider endpoint is not exposed.");
  if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.model !== "string") throw badRequest("A model request is required.");
  if (!target.models.includes(body.model) || (target.model && body.model !== target.model)) throw deny("This runtime may only use its configured model.");
  const query = req.query as Record<string, unknown>;
  if (Object.keys(query).some(k => k !== "beta") || (query.beta !== undefined && query.beta !== "true")) throw badRequest("Unsupported provider query.");
  const endpoint = protocol === "anthropic" ? `${anthropicBaseUrl(target.baseUrl) ?? "https://api.anthropic.com"}/${path}` : `${target.baseUrl}/chat/completions`;
  const abort = new AbortController();
  const disconnected = () => { if (!reply.raw.writableEnded) abort.abort(); };
  reply.raw.on("close", disconnected);
  try {
    const headers: Record<string, string> = { "content-type": "application/json", ...keyHeaders(target.apiKey, target.authHeader) };
    if (protocol === "anthropic") {
      headers["anthropic-version"] = "2023-06-01";
      const beta = req.headers["anthropic-beta"];
      if (typeof beta === "string" && beta.length <= 1000) headers["anthropic-beta"] = beta;
      if (target.workspaceId) headers["anthropic-workspace-id"] = target.workspaceId;
    }
    const response = await providerFetch(`${endpoint}${query.beta === "true" ? "?beta=true" : ""}`, { method: "POST", headers,
      body: JSON.stringify(body), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]) });
    reply.header("cache-control", "no-store");
    if (!response.ok) {
      await response.body?.cancel();
      return reply.status(response.status).send({ error: { type: "provider_error", message: `Provider request failed (HTTP ${response.status}).` } });
    }
    if (!response.body) throw new Error("Missing provider response.");
    reply.header("content-type", response.headers.get("content-type")?.includes("text/event-stream") ? "text/event-stream" : "application/json");
    return reply.send(Readable.fromWeb(response.body as any));
  } catch {
    return reply.status(502).send({ error: { type: "provider_error", message: "Provider connection failed." } });
  }
}
