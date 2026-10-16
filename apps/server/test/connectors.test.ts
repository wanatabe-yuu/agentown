import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
let worker: string;
let mcp: http.Server;
const calls: Array<{ method: string; auth?: string; session?: string }> = [];

/** A small MCP server: JSON for most replies, an SSE stream for tool calls; it wants "Bearer s3cret". */
function startMcp(): Promise<string> {
  mcp = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const m = JSON.parse(body);
      calls.push({ method: m.method, auth: req.headers.authorization, session: req.headers["mcp-session-id"] as string | undefined });
      if (req.headers.authorization !== "Bearer s3cret") return res.writeHead(401).end("unauthorized");
      if (m.id === undefined) return res.writeHead(202).end();
      const result =
        m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mock", version: "1" } }
        : m.method === "tools/list" ? { tools: [{ name: "echo", description: "Says it back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] }
        : m.method === "tools/call" ? { content: [{ type: "text", text: `echo: ${m.params.arguments.text}` }] }
        : null;
      if (m.method === "tools/call") {
        res.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "sess-1" });
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
        return res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result })}\n\n`);
      }
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    });
  });
  return new Promise((r) => mcp.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`)));
}

beforeAll(async () => {
  env = await setup();
  const url = await startMcp();
  worker = (await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Caller", reportsToAgentId: "lead-eng" })).body.agent.id;
  const old = await env.call(env.owner, "GET", "/api/world");
  const r = await env.call(env.owner, "PUT", "/api/world", {
    revision: old.body.revision,
    world: {
      floors: [{ id: "ground", name: "Ground", rooms: [{ id: "office", name: "Office", area: { x: 0, z: 0, w: 10, d: 10 } }] }],
      connectors: { shop: { name: "Shop", url, description: "Orders and stock" }, notes: { name: "Notes", url, approval: "auto" } },
    },
  });
  expect(r.status).toBe(200);
  await env.settle();
});
afterAll(async () => {
  mcp?.close();
  await env?.close();
});

const tool = (id: string, args: unknown) => env.call(env.token(worker), "POST", `/api/tools/${id}/invoke`, { args });

describe("connectors (MCP servers of the world)", () => {
  it("are listed without their credential; only the owner sets it, and it is never shown back", async () => {
    const list = await tool("connector_tools", {});
    expect(list.body.result.connectors).toEqual([
      expect.objectContaining({ id: "shop", name: "Shop", approval: "ask", ready: false }),
      expect.objectContaining({ id: "notes", approval: "auto", ready: false }),
    ]);
    const refused = await tool("connector_tools", { connector: "notes" });
    expect(refused.status).toBe(502);
    expect(refused.body.message).toMatch(/refused the credential/);
    expect((await env.call(env.token(worker), "PUT", "/api/connectors/notes/credential", { value: "Bearer s3cret" })).status).toBe(403);
    for (const id of ["shop", "notes"]) expect((await env.call(env.owner, "PUT", `/api/connectors/${id}/credential`, { value: "Bearer s3cret" })).body.credential).toEqual({ header: "Authorization" });
    const owner = await env.call(env.owner, "GET", "/api/connectors");
    expect(JSON.stringify(owner.body)).not.toContain("s3cret");
    expect((await tool("connector_tools", { connector: "notes" })).body.result.tools).toEqual([expect.objectContaining({ name: "echo" })]);
    expect(calls.filter((c) => c.method === "tools/list").at(-1)).toMatchObject({ auth: "Bearer s3cret", session: "sess-1" });
  });

  it("an auto connector's call runs at once (SSE reply); an ask one waits for approval", async () => {
    const auto = await tool("connector_call", { connector: "notes", tool: "echo", arguments: { text: "hi" } });
    expect(auto.status).toBe(200);
    expect(auto.body.result).toMatchObject({ connector: "notes", tool: "echo", isError: false, text: "echo: hi" });
    expect((await tool("connector_call", { connector: "notes", tool: "nope", arguments: {} })).status).toBe(400);

    const asked = await tool("connector_call", { connector: "shop", tool: "echo", arguments: { text: "order 42" } });
    expect(asked.status).toBe(202);
    const before = calls.filter((c) => c.method === "tools/call").length;
    const ok = await env.call(env.owner, "POST", `/api/proposals/${asked.body.proposalId}/decide`, { verdict: "approve" });
    expect(ok.body.proposal.status).toBe("applied");
    expect(calls.filter((c) => c.method === "tools/call").length).toBe(before + 1);
  });
});
