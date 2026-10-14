import Anthropic from "@anthropic-ai/sdk";
import { providerFetch, registerProviderKey } from "./key-redaction.ts";
import { apiProtocol, defaultAuthHeader, keyHeaders, anthropicBaseUrl, anthropicKeyHeaders, type ApiProtocol, type AuthHeader } from "@agentown/core";

/**
 * LLM providers an owner can add keys for. Anthropic uses its own SDK and
 * adapter; every other provider speaks the OpenAI-compatible Chat Completions
 * API (`GET /models`, `POST /chat/completions` with function calling), so one
 * adapter covers them all and `custom` points it at any compatible endpoint
 * (Ollama, vLLM, LM Studio, a gateway...).
 */
export interface ProviderInfo {
  id: string;
  label: string;
  /** Fixed endpoint for the preset providers; null for `custom` (the owner supplies it). */
  baseUrl: string | null;
  keyRequired: boolean;
  keyPlaceholder: string;
}

export const PROVIDER_INFO = [
  { id: "anthropic", label: "Anthropic (Claude)", baseUrl: null, keyRequired: true, keyPlaceholder: "sk-ant-…" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", keyRequired: true, keyPlaceholder: "sk-…" },
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", keyRequired: true, keyPlaceholder: "sk-…" },
  { id: "xai", label: "xAI (Grok)", baseUrl: "https://api.x.ai/v1", keyRequired: true, keyPlaceholder: "xai-…" },
  { id: "gemini", label: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyRequired: true, keyPlaceholder: "AIza…" },
  { id: "mistral", label: "Mistral", baseUrl: "https://api.mistral.ai/v1", keyRequired: true, keyPlaceholder: "" },
  { id: "groq", label: "Groq", baseUrl: "https://api.groq.com/openai/v1", keyRequired: true, keyPlaceholder: "gsk_…" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", keyRequired: true, keyPlaceholder: "sk-or-…" },
  { id: "together", label: "Together AI", baseUrl: "https://api.together.xyz/v1", keyRequired: true, keyPlaceholder: "" },
  { id: "custom", label: "Custom URL", baseUrl: null, keyRequired: false, keyPlaceholder: "optional" },
] as const satisfies readonly ProviderInfo[];

export type Provider = (typeof PROVIDER_INFO)[number]["id"];
export const PROVIDERS = PROVIDER_INFO.map((p) => p.id) as [Provider, ...Provider[]];

export function providerInfo(id: string): ProviderInfo | undefined {
  return PROVIDER_INFO.find((p) => p.id === id);
}

/** The Chat Completions endpoint for a credential: the preset's, or the owner's for `custom`. */
export function providerBaseUrl(provider: Provider, customBaseUrl: string | null): string | null {
  return provider === "custom" ? customBaseUrl : (providerInfo(provider)?.baseUrl ?? null);
}

/**
 * Validates an owner-supplied endpoint: http(s) only (plain http is allowed for
 * local servers such as Ollama), no credentials in the URL, no query/fragment.
 * Returns the normalized URL without a trailing slash, or throws.
 */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("base URL is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("base URL must use http or https");
  if (u.username || u.password) throw new Error("base URL must not contain credentials; put the key in the API key field");
  if (u.search || u.hash) throw new Error("base URL must not have a query string or fragment");
  return u.toString().replace(/\/+$/, "");
}

/**
 * Anthropic workspace ids look like `wrkspc_01…`. A key created at the
 * organization level (not inside a workspace) must name the workspace on every
 * request with the `anthropic-workspace-id` header.
 */
export const WORKSPACE_ID_PATTERN = /^wrkspc_[A-Za-z0-9]{1,100}$/;

export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> | undefined {
  return workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined;
}

export interface ProviderTarget {
  provider: Provider;
  apiKey: string;
  /** Anthropic only. */
  workspaceId: string | null;
  /** OpenAI-compatible providers: the resolved endpoint. */
  baseUrl: string | null;
  protocol?: ApiProtocol;
  authHeader?: AuthHeader;
}

/** Returns the model ids this key can use; throws if the provider rejects it. */
export type ModelLister = (target: ProviderTarget) => Promise<string[]>;

// Models a Chat Completions agent cannot use (embeddings, speech, images, moderation...).
const NON_CHAT = /(embed|tts|whisper|dall-e|moderation|transcribe|audio|realtime|image|rerank|guard|search-preview)/i;

export const listModels: ModelLister = async ({ provider, apiKey, workspaceId, baseUrl, protocol, authHeader }) => {
  registerProviderKey(apiKey);
  const wire = apiProtocol(provider, protocol);
  const auth = authHeader ?? defaultAuthHeader(wire);
  if (wire === "anthropic") {
    const client = new Anthropic({ apiKey, authToken: null, ...(baseUrl ? { baseURL: anthropicBaseUrl(baseUrl) } : {}),
      defaultHeaders: { ...workspaceHeaders(workspaceId), ...anthropicKeyHeaders(apiKey, auth) }, fetch: providerFetch, logLevel: "off", maxRetries: 1, timeout: 20_000 });
    const ids: string[] = [];
    for await (const m of client.models.list()) ids.push(m.id);
    return ids;
  }
  if (!baseUrl) throw new Error(`no endpoint for provider ${provider}`);
  const get = async (path: string) => {
    const res = await providerFetch(`${baseUrl}${path}`, {
      headers: { accept: "application/json", ...keyHeaders(apiKey, auth) },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
    return text;
  };
  // OpenRouter lists models without checking the key; its key endpoint does.
  if (provider === "openrouter") await get("/key");
  const text = await get("/models");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("the endpoint did not return JSON for GET /models");
  }
  // OpenAI shape is { data: [{ id }] }; some providers return the array directly.
  const list = Array.isArray(body) ? body : (body as { data?: unknown })?.data;
  if (!Array.isArray(list)) throw new Error("unexpected GET /models response (no data array)");
  const raw = list.map((m) => (m as { id?: unknown })?.id).filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200);
  // Gemini lists "models/gemini-…"; its Chat Completions examples use the bare id.
  const ids = [...new Set(provider === "gemini" ? raw.map((id) => id.replace(/^models\//, "")) : raw)];
  const chat = ids.filter((id) => !NON_CHAT.test(id));
  return (chat.length ? chat : ids).sort();
};
