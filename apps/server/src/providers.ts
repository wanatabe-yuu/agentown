import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = ["anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * Anthropic workspace ids look like `wrkspc_01…`. A key created at the
 * organization level (not inside a workspace) must name the workspace on every
 * request with the `anthropic-workspace-id` header.
 */
export const WORKSPACE_ID_PATTERN = /^wrkspc_[A-Za-z0-9]{1,100}$/;

export function workspaceHeaders(workspaceId: string | null | undefined): Record<string, string> | undefined {
  return workspaceId ? { "anthropic-workspace-id": workspaceId } : undefined;
}

/** Returns the model ids this API key can use; throws if the key is rejected. */
export type ModelLister = (provider: Provider, apiKey: string, workspaceId: string | null) => Promise<string[]>;

export const listModels: ModelLister = async (provider, apiKey, workspaceId) => {
  if (provider !== "anthropic") throw new Error(`unsupported provider ${provider}`);
  const client = new Anthropic({ apiKey, defaultHeaders: workspaceHeaders(workspaceId), maxRetries: 1, timeout: 20_000 });
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids;
};
