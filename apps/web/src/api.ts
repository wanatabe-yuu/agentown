import { t } from "./i18n.ts";
/**
 * Browser API client. The browser holds only the signed-in person's Agentown
 * token, and only inside an HttpOnly cookie that page scripts cannot read —
 * never a kubeconfig, Docker socket or agent credential. Every action is a
 * structured request the server authorizes on its own.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Install-level routes; everything else under /api/ runs in the chosen organization. */
const INSTANCE = /^\/api\/(me|session|admin|templates|marketplace|orgs)(\/|$|\?)/;
let orgBase: string | null = null;

/** Point org routes at this organization (`/api/x` → `/api/orgs/<id>/x`). */
export function setOrg(id: string | null) {
  orgBase = id ? `/api/orgs/${encodeURIComponent(id)}` : null;
}

/** Plain /api/me is the account; the org-level one is written out as /api/orgs/<id>/me. */
export function orgPath(path: string): string {
  if (!orgBase || !path.startsWith("/api/") || INSTANCE.test(path)) return path;
  return orgBase + path.slice(4);
}

/**
 * A reply that is not ours (a proxy's error page while the server restarts):
 * a short sentence, never the page's HTML.
 */
export function plainError(status: number, text: string): string {
  if (status === 502 || status === 503 || status === 504 || /<html|<!doctype/i.test(text)) {
    return status >= 502 && status <= 504 ? t("The server is restarting or briefly unreachable ({status}). Try again in a moment.", { status }) : t("Unexpected reply from the server ({status}).", { status });
  }
  return text.trim().slice(0, 300) || `HTTP ${status}`;
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(orgPath(path), {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null as T;
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { message: plainError(res.status, text) };
  }
  // Show the server's reason for a denial instead of silently hiding things.
  if (!res.ok) throw new HttpError(res.status, json?.message ?? `HTTP ${res.status}`);
  return json as T;
}

export async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(orgPath(path));
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  return res.blob();
}

/** SSE over fetch. Resolves when the stream ends; the caller reconnects from a fresh snapshot. */
export async function streamEvents(after: number, onEvent: (e: any) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(orgPath(`/api/events?after=${after}`), {
    headers: { accept: "text/event-stream" },
    signal,
  });
  if (!res.ok || !res.body) throw new HttpError(res.status, "event stream failed");
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += value;
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) onEvent(JSON.parse(data));
    }
  }
}
