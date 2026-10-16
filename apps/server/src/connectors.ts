import type { Actor } from "@agentown/core";
import type { Service } from "./service.ts";
import { ApiError, badRequest, deny, notFound } from "./util.ts";

/**
 * Connectors: MCP servers (Streamable HTTP) that come with the world. The world
 * names them and says whether each call waits for approval ("ask") or runs at
 * once ("auto"); the owner sets their credential (a header, sealed at rest,
 * never shown again or given to agents). Agents call them through the gateway.
 */

const TOOLS_TTL = 5 * 60_000;
const TIMEOUT = 60_000;
const toolCache = new Map<string, { at: number; tools: McpTool[] }>();

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

function connectorOf(service: Service, id: string) {
  const c = service.config.world?.connectors[id];
  if (!c) throw notFound("connector");
  return c;
}

/** Whether a call to this connector waits for approval (unknown ones do; the call then fails as not found). */
export function connectorAsks(service: Service, id: string): boolean {
  return service.config.world?.connectors[id]?.approval !== "auto";
}

export async function listConnectors(service: Service) {
  const { rows } = await service.db.query<{ connector_id: string; header: string }>("SELECT connector_id, header FROM connector_credentials WHERE org_id=$1", [service.orgId]);
  const creds = new Map(rows.map((r) => [r.connector_id, r.header]));
  return Object.entries(service.config.world?.connectors ?? {}).map(([id, c]) => ({
    id, name: c.name, url: c.url, description: c.description ?? null, approval: c.approval,
    credential: creds.has(id) ? { header: creds.get(id)! } : null,
  }));
}

export async function setConnectorCredential(service: Service, actor: Actor, id: string, cred: { header: string; value: string } | null) {
  if (!(actor.kind === "human" && actor.owner)) throw deny("only the owner sets connector credentials");
  connectorOf(service, id);
  if (!cred) await service.db.query("DELETE FROM connector_credentials WHERE org_id=$1 AND connector_id=$2", [service.orgId, id]);
  else {
    await service.db.query(
      `INSERT INTO connector_credentials(org_id, connector_id, header, ciphertext) VALUES ($1,$2,$3,$4)
       ON CONFLICT (org_id, connector_id) DO UPDATE SET header=EXCLUDED.header, ciphertext=EXCLUDED.ciphertext, updated_at=now()`,
      [service.orgId, id, cred.header, service.secrets.seal(cred.value)],
    );
  }
  toolCache.delete(`${service.orgId}/${id}`);
  await service.kernel.permissions.audit(service.db, actor, cred ? "connector.credential_set" : "connector.credential_removed", id, true, cred ? cred.header : "");
  return (await listConnectors(service)).find((c) => c.id === id)!;
}

async function headersOf(service: Service, id: string): Promise<Record<string, string>> {
  const { rows } = await service.db.query<{ header: string; ciphertext: Buffer }>("SELECT header, ciphertext FROM connector_credentials WHERE org_id=$1 AND connector_id=$2", [service.orgId, id]);
  return rows[0] ? { [rows[0].header]: service.secrets.open(rows[0].ciphertext) } : {};
}

/** One MCP session: initialize, then the requests. Replies come as JSON or as an SSE stream. */
async function session(url: string, headers: Record<string, string>) {
  let sid: string | null = null;
  let seq = 0;
  const post = async (body: Record<string, unknown>) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(TIMEOUT),
    }).catch((err) => {
      throw new ApiError(502, "connector_unreachable", `the connector did not answer: ${(err as Error).message}`);
    });
    sid = r.headers.get("mcp-session-id") ?? sid;
    if (!r.ok) {
      const text = (await r.text().catch(() => "")).slice(0, 300);
      throw new ApiError(502, "connector_error", r.status === 401 || r.status === 403 ? `the connector refused the credential (${r.status}); the owner sets it in Settings → Connectors` : `the connector answered ${r.status}: ${text}`);
    }
    if (body.id === undefined) {
      await r.body?.cancel().catch(() => {});
      return null;
    }
    const msg = (r.headers.get("content-type") ?? "").includes("text/event-stream") ? await fromStream(r, body.id as number) : await r.json();
    if (msg?.error) throw new ApiError(502, "connector_error", `the connector failed: ${String(msg.error.message ?? "error").slice(0, 500)}`);
    return msg?.result;
  };
  await post({ id: ++seq, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agentown", version: "1" } } });
  await post({ method: "notifications/initialized" });
  return { request: (method: string, params: Record<string, unknown>) => post({ id: ++seq, method, params }) };
}

async function fromStream(r: Response, id: number): Promise<any> {
  const reader = r.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let at: number;
      while ((at = buf.search(/\r?\n\r?\n/)) >= 0) {
        const block = buf.slice(0, at);
        buf = buf.slice(at).replace(/^\r?\n\r?\n/, "");
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          const msg = JSON.parse(data);
          if (msg.id === id) return msg;
        } catch {}
      }
      if (done) throw new ApiError(502, "connector_error", "the connector closed the stream without an answer");
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function connectorTools(service: Service, id: string): Promise<McpTool[]> {
  const c = connectorOf(service, id);
  const key = `${service.orgId}/${id}`;
  const hit = toolCache.get(key);
  if (hit && Date.now() - hit.at < TOOLS_TTL) return hit.tools;
  const s = await session(c.url, await headersOf(service, id));
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const r = await s.request("tools/list", cursor ? { cursor } : {});
    tools.push(...((r?.tools ?? []) as McpTool[]).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })));
    cursor = r?.nextCursor;
  } while (cursor && tools.length < 500);
  toolCache.set(key, { at: Date.now(), tools });
  return tools;
}

/** Call one tool; text parts are joined, anything else is described. */
export async function callConnector(service: Service, id: string, tool: string, args: Record<string, unknown>) {
  const c = connectorOf(service, id);
  if (!(await connectorTools(service, id)).some((t) => t.name === tool)) throw badRequest(`${c.name} has no tool ${tool}`);
  const s = await session(c.url, await headersOf(service, id));
  const r = await s.request("tools/call", { name: tool, arguments: args });
  const parts = ((r?.content ?? []) as Array<{ type: string; text?: string; mimeType?: string; resource?: { uri?: string; text?: string } }>).map((p) =>
    p.type === "text" ? p.text ?? "" : p.type === "resource" ? p.resource?.text ?? `[resource ${p.resource?.uri ?? ""}]` : `[${p.type}${p.mimeType ? ` ${p.mimeType}` : ""}]`,
  );
  const text = parts.join("\n").slice(0, 50_000);
  return { connector: id, tool, isError: !!r?.isError, text, ...(r?.structuredContent ? { structured: r.structuredContent } : {}) };
}
