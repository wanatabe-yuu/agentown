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

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
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
    json = { message: text };
  }
  // Show the server's reason for a denial instead of silently hiding things.
  if (!res.ok) throw new HttpError(res.status, json?.message ?? `HTTP ${res.status}`);
  return json as T;
}

export async function fetchBlob(path: string): Promise<Blob> {
  const res = await fetch(path);
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  return res.blob();
}

/** SSE over fetch. Resolves when the stream ends; the caller reconnects from a fresh snapshot. */
export async function streamEvents(after: number, onEvent: (e: any) => void, signal: AbortSignal): Promise<void> {
  const res = await fetch(`/api/events?after=${after}`, {
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
