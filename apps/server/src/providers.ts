import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = ["anthropic"] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Returns the model ids this API key can use; throws if the key is rejected. */
export type ModelLister = (provider: Provider, apiKey: string) => Promise<string[]>;

export const listModels: ModelLister = async (provider, apiKey) => {
  if (provider !== "anthropic") throw new Error(`unsupported provider ${provider}`);
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20_000 });
  const ids: string[] = [];
  for await (const m of client.models.list()) ids.push(m.id);
  return ids;
};
