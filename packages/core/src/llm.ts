import { z } from "zod";

export type ApiProtocol = "anthropic" | "openai";
export const authHeaderSchema = z.object({
  name: z.string().trim().toLowerCase().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/)
    .refine(n => !["host", "cookie", "content-type", "content-length", "connection", "transfer-encoding", "anthropic-version", "anthropic-beta", "anthropic-workspace-id"].includes(n), "Choose an authentication header, not a transport or protocol header."),
  scheme: z.enum(["raw", "bearer"]),
}).strict();
export type AuthHeader = z.infer<typeof authHeaderSchema>;

export function apiProtocol(provider: string, custom?: ApiProtocol | null): ApiProtocol {
  return provider === "anthropic" ? "anthropic" : provider === "custom" ? custom ?? "openai" : "openai";
}
export function defaultAuthHeader(protocol: ApiProtocol): AuthHeader {
  return protocol === "anthropic" ? { name: "x-api-key", scheme: "raw" } : { name: "authorization", scheme: "bearer" };
}
export function keyHeaders(apiKey: string, auth: AuthHeader): Record<string, string> {
  return apiKey ? { [auth.name]: auth.scheme === "bearer" ? `Bearer ${apiKey}` : apiKey } : {};
}
/** SDK routes already start with /v1. Accept both gateway root and /v1 input. */
export function anthropicBaseUrl(baseUrl: string | null | undefined): string | undefined {
  return baseUrl?.replace(/\/+$/, "").replace(/\/v1$/, "") || undefined;
}
/** Explicitly omit the SDK's other auth header so a gateway gets only the chosen one. */
export function anthropicKeyHeaders(apiKey: string, auth: AuthHeader): Record<string, string | null> {
  return { "x-api-key": null, authorization: null, ...keyHeaders(apiKey, auth) };
}
