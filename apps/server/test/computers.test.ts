import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
let worker: string;
const sent: Array<{ method: string; params: any; sessionId?: string }> = [];

beforeAll(async () => {
  env = await setup();
  worker = (await env.call(env.owner, "POST", "/api/agents", { templateId: "engineer-v1", displayName: "Surfer", reportsToAgentId: "lead-eng" })).body.agent.id;
  const old = await env.call(env.owner, "GET", "/api/world");
  const r = await env.call(env.owner, "PUT", "/api/world", {
    revision: old.body.revision,
    world: {
      floors: [{ id: "ground", name: "Ground", rooms: [{ id: "office", name: "Office", department: "eng", area: { x: 0, z: 0, w: 10, d: 10 } }] }],
      kinds: { pc: { name: "Computer", category: "static", look: { parts: [{ shape: "box" }] }, browser: {} }, desk: { name: "Desk", category: "static", look: { parts: [{ shape: "box" }] } } },
      objects: [{ id: "pc-1", kind: "pc", room: "office", at: [1, 1], label: "Front PC" }, { id: "desk-1", kind: "desk", room: "office", at: [3, 3] }],
    },
  });
  expect(r.status).toBe(200);
  await env.settle();
});
afterAll(async () => env?.close());

const computers = () => env.instance.computers!;

/** A browser as its pod's bridge would carry it: answers the DevTools calls the server makes. */
async function fakeBridge(token: string) {
  let ws!: WebSocket;
  let url = "about:blank";
  const reply = (id: number, result: unknown) => ws.send(JSON.stringify({ id, result }));
  const event = (method: string, params: unknown, sessionId?: string) => ws.send(JSON.stringify({ method, params, ...(sessionId ? { sessionId } : {}) }));
  const onMessage = (raw: Buffer) => {
    const m = JSON.parse(raw.toString());
    sent.push(m);
    switch (m.method) {
      case "Target.getTargets":
        return reply(m.id, { targetInfos: [{ targetId: "T1", type: "page", url, title: "" }] });
      case "Target.attachToTarget":
        return reply(m.id, { sessionId: "S1" });
      case "Page.navigate":
        url = m.params.url;
        reply(m.id, { frameId: "F1" });
        event("Target.targetInfoChanged", { targetInfo: { targetId: "T1", type: "page", url, title: "Example Domain" } });
        return event("Page.loadEventFired", { timestamp: 1 }, "S1");
      case "Accessibility.getFullAXTree":
        return reply(m.id, {
          nodes: [
            { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "Example Domain" }, childIds: ["2", "3", "5", "6"] },
            { nodeId: "2", role: { value: "heading" }, name: { value: "Example Domain" }, childIds: ["9"] },
            { nodeId: "3", role: { value: "paragraph" }, childIds: ["4"] },
            { nodeId: "4", role: { value: "StaticText" }, name: { value: "This domain is for use in examples." } },
            { nodeId: "5", role: { value: "link" }, name: { value: "More information" }, backendDOMNodeId: 7, childIds: ["8"] },
            { nodeId: "6", role: { value: "textbox" }, name: { value: "Search" }, value: { value: "" }, backendDOMNodeId: 11 },
            { nodeId: "8", role: { value: "StaticText" }, name: { value: "More information" } },
            { nodeId: "9", role: { value: "StaticText" }, name: { value: "Example Domain" } },
          ],
        });
      case "DOM.getContentQuads":
        return reply(m.id, { quads: [[10, 10, 30, 10, 30, 20, 10, 20]] });
      case "DOM.resolveNode":
        return reply(m.id, { object: { objectId: "O1" } });
      case "Page.startScreencast":
        reply(m.id, {});
        return event("Page.screencastFrame", { data: "SlBFRw==", sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } }, "S1");
      default:
        return reply(m.id, {});
    }
  };
  // Listen before the server's first call arrives.
  await env.app.injectWS("/api/browser/bridge", { headers: { authorization: `Bearer ${token}` } } as any, {
    onInit: (socket) => {
      ws = socket as unknown as WebSocket;
      socket.on("message", onMessage);
    },
  });
  return ws;
}

const invoke = (args: Record<string, unknown>) => env.call(env.token(worker), "POST", "/api/tools/browser/invoke", { args });

describe("the world's computers", () => {
  it("lists computers, and starts one as a pod when an agent uses it", async () => {
    const list = await env.call(env.token(worker), "GET", "/api/computers");
    expect(list.body.computers).toEqual([expect.objectContaining({ id: "pc-1", name: "Front PC", state: "off" })]);
    expect((await invoke({ computer: "desk-1", action: "look" })).status).toBe(404);
    expect((await invoke({ computer: "pc-1", action: "open" })).status).toBe(400); // open needs a url
  });

  it("an agent opens a page and gets it as text with refs; clicks and types go to the browser", async () => {
    const pending = invoke({ computer: "pc-1", action: "open", url: "example.com" });
    await new Promise((r) => setTimeout(r, 100));
    await computers().reconcile();
    const pod = [...env.driver.pods.values()].find((p) => p.runtimeId.startsWith("pc-pc-1-"));
    expect(pod).toMatchObject({ namespace: "agentown-eng", env: { AGENTOWN_HARNESS: "browser" } });
    // Only the computer's own token connects a browser.
    const intruder = await env.app.injectWS("/api/browser/bridge", { headers: { authorization: `Bearer ${await env.member(worker)}` } } as any);
    await new Promise<void>((r) => intruder.on("close", () => r()));
    await fakeBridge(env.driver.tokens.get(pod!.runtimeId)!);
    const r = await pending;
    expect(r.status).toBe(200);
    // A computer naming no home page opens Google first; then the page it was asked for.
    expect(sent.filter((m) => m.method === "Page.navigate").map((m) => m.params.url)).toEqual(["https://www.google.com", "https://example.com"]);
    const page: string = r.body.result.page;
    expect(page).toContain("URL: https://example.com");
    expect(page).toContain("heading: Example Domain");
    expect(page).toContain("This domain is for use in examples.");
    expect(page).toContain('- link "More information" [e1]');
    expect(page).toContain('- textbox "Search" [e2]');
    expect(page.match(/More information/g)).toHaveLength(1); // a link's own text is not repeated

    sent.length = 0;
    expect((await invoke({ computer: "pc-1", action: "click", ref: "e1" })).status).toBe(200);
    expect(sent.filter((m) => m.method === "Input.dispatchMouseEvent").map((m) => [m.params.type, m.params.x, m.params.y])).toEqual([
      ["mouseMoved", 20, 15], ["mousePressed", 20, 15], ["mouseReleased", 20, 15],
    ]);
    sent.length = 0;
    expect((await invoke({ computer: "pc-1", action: "type", ref: "e2", text: "cà phê", submit: true })).status).toBe(200);
    expect(sent.find((m) => m.method === "Input.insertText")?.params.text).toBe("cà phê");
    expect(sent.find((m) => m.method === "Input.dispatchKeyEvent")?.params).toMatchObject({ type: "keyDown", key: "Enter", text: "\r" });
    // Refs come from the latest look; agents cannot open browser-internal pages.
    expect((await invoke({ computer: "pc-1", action: "click", ref: "e99" })).status).toBe(400);
    expect((await invoke({ computer: "pc-1", action: "open", url: "chrome://settings" })).status).toBe(400);
  });

  it("the owner watches the screen and drives it by hand; agents cannot watch", async () => {
    const path = `/api/orgs/${env.instance.defaultOrgId}/computers/pc-1/screen`;
    const frames: any[] = [];
    const viewer = await env.app.injectWS(path, { headers: { authorization: `Bearer ${env.owner}` } } as any, { onInit: (v) => v.on("message", (d: Buffer, binary: boolean) => frames.push(binary ? { jpeg: d.toString() } : JSON.parse(d.toString()))) });
    await new Promise((r) => setTimeout(r, 300));
    // Frames are binary JPEG (here the bytes "JPEG"); their page size comes once, as JSON.
    expect(frames).toContainEqual({ jpeg: "JPEG" });
    expect(frames).toContainEqual({ t: "size", w: 1280, h: 800 });
    expect(frames).toContainEqual(expect.objectContaining({ t: "page", url: "https://example.com", title: "Example Domain" }));
    sent.length = 0;
    viewer.send(JSON.stringify({ t: "mouse", type: "mousePressed", x: 5, y: 6, button: "left", clickCount: 1 }));
    viewer.send(JSON.stringify({ t: "text", text: "secret-password" }));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent.find((m) => m.method === "Input.dispatchMouseEvent")?.params).toMatchObject({ type: "mousePressed", x: 5, y: 6 });
    expect(sent.find((m) => m.method === "Input.insertText")?.params.text).toBe("secret-password");
    viewer.close();

    const agent = await env.app.injectWS(`/api/computers/pc-1/screen`, { headers: { authorization: `Bearer ${await env.member(worker)}` } } as any);
    const closed = await new Promise<number>((r) => agent.on("close", (code: number) => r(code)));
    expect(closed).toBe(4403);
  });

  it("an agent asks the owner to log in on a computer; the question names it", async () => {
    const t = (await env.call(env.owner, "POST", "/api/tasks", { title: "Check orders", assigneeAgentId: worker })).body.task;
    const g = (await env.service.getRuntimeRow(worker)).generation;
    await env.call(env.token(worker), "POST", "/api/runtime/heartbeat", { generation: g, state: "idle" });
    expect((await env.call(env.token(worker), "POST", "/api/runs/claim", { generation: g })).body.task.id).toBe(t.id);
    const asked = await env.call(env.token(worker), "POST", `/api/tasks/${t.id}/ask`, { question: "Please log in on computer pc-1: Shopee seller", computer: "pc-1" });
    expect(asked.status).toBe(201);
    const q = (await env.call(env.owner, "GET", "/api/proposals?status=pending")).body.proposals.find((p: any) => p.id === asked.body.questionId);
    expect(q.payload.computer).toBe("pc-1");
  });

  it("turning a computer off removes its pod (its profile volume stays)", async () => {
    expect((await env.call(env.token(worker), "POST", "/api/computers/pc-1/stop")).status).toBe(403);
    const r = await env.call(env.owner, "POST", "/api/computers/pc-1/stop");
    expect(r.status).toBe(200);
    expect([...env.driver.pods.values()].some((p) => p.runtimeId.startsWith("pc-pc-1-"))).toBe(false);
    expect(r.body.state).toBe("off");
  });
});


describe("a computer that cannot start", () => {
  it("says why right away (a full quota) instead of making the agent wait", async () => {
    const real = env.driver.ensureIdentity.bind(env.driver);
    env.driver.ensureIdentity = async () => {
      throw Object.assign(new Error("HTTP-Code: 403"), { body: JSON.stringify({ message: 'persistentvolumeclaims "x" is forbidden: exceeded quota: agentown-quota' }) });
    };
    const pending = invoke({ computer: "pc-1", action: "look" });
    await new Promise((r) => setTimeout(r, 100));
    await computers().reconcile();
    const r = await pending;
    env.driver.ensureIdentity = real;
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/exceeded quota/);
  });
});
