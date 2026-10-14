import { createHash, randomBytes } from "node:crypto";
import type { Actor } from "@agentown/core";
import { redactProviderKeys } from "./key-redaction.ts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
  }
}

export const deny = (reason: string) => new ApiError(403, "forbidden", reason);
export const notFound = (what: string) => new ApiError(404, "not_found", `${what} not found`);
export const conflict = (code: string, msg: string) => new ApiError(409, code, msg);
export const badRequest = (msg: string, detail?: unknown) => new ApiError(400, "bad_request", msg, detail);

/** Lowercase, DNS-label-safe random id. */
export function newId(prefix: string, bytes = 5): string {
  return `${prefix}-${randomBytes(bytes).toString("hex")}`;
}

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function actorRef(actor: Actor): string {
  return actor.kind === "human" ? `human:${actor.id}` : `agent:${actor.id}`;
}

const SECRETISH = /(token|secret|password|api[_-]?key|authorization)/i;

/** Strip anything that looks like a credential before it reaches events, logs or audit. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") return redactLine(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRETISH.test(k) ? "[redacted]" : sanitize(v, depth + 1);
    return out;
  }
  return value;
}

const LINE_PATTERNS: RegExp[] = [
  /(sk-ant-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi,
  /((?:token|secret|password|api[_-]?key)\s*[=:]\s*)\S+/gi,
];

export function redactLine(line: string): string {
  let out = redactProviderKeys(line);
  out = out.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[redacted]");
  for (const re of LINE_PATTERNS) out = out.replace(re, "$1[redacted]");
  return out;
}
