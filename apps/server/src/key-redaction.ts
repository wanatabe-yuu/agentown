const secrets = new Set<string>();
export function registerProviderKey(key: string) {
  if (key.length < 8) return;
  for (const value of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key), Buffer.from(key).toString("base64"), Buffer.from(key).toString("base64url")]) secrets.add(value);
  // Remove old displayed hints and the old logger's retained Anthropic prefix too.
  secrets.add(`…${key.slice(-4)}`);
  secrets.add(`\\u2026${key.slice(-4)}`);
  if (key.startsWith("sk-ant-")) secrets.add(`${key.slice(0, 15)}[redacted]`);
}
export function redactProviderKeys(text: string): string {
  for (const key of secrets) text = text.split(key).join("[redacted]");
  return text;
}
/** Hold incomplete matches across network chunks; never emit a key prefix. */
export function redactedBody(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder(); const encoder = new TextEncoder(); let pending = "";
  const flush = (last: boolean) => {
    pending = redactProviderKeys(pending);
    let end = pending.length;
    if (!last) for (const key of secrets) for (let n = 1; n < key.length && n <= pending.length; n++) {
      if (pending.endsWith(key.slice(0, n))) end = Math.min(end, pending.length - n);
    }
    const out = pending.slice(0, end); pending = pending.slice(end); return encoder.encode(out);
  };
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) { pending += decoder.decode(chunk, { stream: true }); controller.enqueue(flush(false)); },
    flush(controller) { pending += decoder.decode(); controller.enqueue(flush(true)); },
  }));
}
/** All provider responses, including SDK error bodies, cross this boundary before parsing. */
export const providerFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, ...(typeof init?.body === "string" ? { body: redactProviderKeys(init.body) } : {}), redirect: "error" });
  const headers = new Headers(response.headers);
  for (const [name, value] of headers) if (redactProviderKeys(value) !== value) headers.delete(name);
  headers.delete("content-length"); headers.delete("content-encoding");
  return new Response(response.body ? redactedBody(response.body) : null, { status: response.status, statusText: response.statusText, headers });
};
