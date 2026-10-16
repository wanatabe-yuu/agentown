import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type WebSocket from "ws";
import { setup } from "./helpers.ts";

// One computer kind; each placed computer's own settings: studio on or off, its network (sealed
// secrets), and running on a paired machine elsewhere (one-time link, its own token, health).
let env: Awaited<ReturnType<typeof setup>>;
let viewer: string;
const inject = async (method: string, url: string, token?: string, body?: unknown) => {
  const r = await env.app.inject({ method: method as "GET", url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(body !== undefined ? { payload: body as object } : {}) });
  let json: any = null;
  try {
    json = r.json();
  } catch {}
  return { status: r.statusCode, body: json, text: r.body };
};

/** A computer runtime's bridge: answers DevTools calls, records control frames, and can say its health. */
async function bridge(token: string) {
  let ws!: WebSocket;
  const control: any[] = [];
  await env.app.injectWS("/api/browser/bridge", { headers: { authorization: `Bearer ${token}` } } as any, {
    onInit: (socket) => {
      ws = socket as unknown as WebSocket;
      socket.on("message", (raw: Buffer) => {
        const m = JSON.parse(raw.toString());
        // A picture asked for (look) comes back empty here: no model is asked in these tests.
        if (m.agentown === "run") socket.send(JSON.stringify({ agentown: "ran", id: m.id, code: 0, output: m.command.endsWith("base64 -w0") ? "" : `ran: ${m.command}\n`, timedOut: false }));
        if (m.agentown) return control.push(m);
        const result =
          m.method === "Target.getTargets" ? { targetInfos: [{ targetId: "T1", type: "page", url: "about:blank", title: "" }] }
          : m.method === "Target.attachToTarget" ? { sessionId: `S-${m.params.targetId}` }
          : m.method === "Target.createTarget" ? { targetId: `T${m.id}` }
          : {};
        socket.send(JSON.stringify({ id: m.id, result }));
        if (m.method === "Page.navigate") socket.send(JSON.stringify({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: m.sessionId }));
      });
    },
  });
  return { ws, control };
}
const until = async (ok: () => unknown) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

beforeAll(async () => {
  env = await setup(undefined, { remote: { port: 7443, pin: "PIN", publicHost: "203.0.113.5" } });
  viewer = (await env.call(env.owner, "POST", "/api/users", { displayName: "Designer", roleId: "admin" })).body.token;
  const old = await env.call(env.owner, "GET", "/api/world");
  const r = await env.call(env.owner, "PUT", "/api/world", {
    revision: old.body.revision,
    world: {
      floors: [{ id: "ground", name: "Ground", rooms: [{ id: "office", name: "Office", department: "eng", area: { x: 0, z: 0, w: 10, d: 10 } }] }],
      kinds: { computer: { name: "Computer", category: "static", look: { parts: [{ shape: "box" }] }, browser: {} } },
      objects: [
        { id: "pc-off", kind: "computer", room: "office", at: [1, 1], computer: { studio: false } },
        { id: "pc-on", kind: "computer", room: "office", at: [2, 2], computer: { studio: true, apps: ["browser", "mcp"], network: "proxy" } },
        { id: "pc-old", kind: "computer", room: "office", at: [3, 3] },
        { id: "pc-far", kind: "computer", room: "office", at: [4, 4], computer: { studio: true, remote: true } },
        { id: "pc-term", kind: "computer", room: "office", at: [5, 5], computer: { studio: true, apps: ["browser", "terminal"] } },
        { id: "pc-look", kind: "computer", room: "office", at: [6, 6], computer: { studio: true, apps: ["terminal"] } },
      ],
      // Workstations: Linh's is a studio computer, Ava's just a desk.
      desks: { "lead-eng": { studio: true, apps: ["browser", "terminal"] }, ceo: { studio: true, label: "Ava's laptop" }, po: { studio: false } },
    },
  });
  expect(r.status).toBe(200);
});
afterAll(async () => env?.close());

describe("computers: one kind, each with its own settings", () => {
  it("only studio computers run; computers from before per-object settings still do", async () => {
    const list = (await env.call(env.owner, "GET", "/api/computers")).body.computers;
    expect(list.map((c: { id: string }) => c.id).sort()).toEqual(["desk:ceo", "desk:lead-eng", "pc-far", "pc-look", "pc-old", "pc-on", "pc-term"]);
    expect(list.find((c: { id: string }) => c.id === "pc-on").apps).toEqual(["browser", "mcp"]);
    expect((await env.call(env.owner, "GET", "/api/computers/pc-off")).status).toBe(404);
  });

  it("its proxy is the owner's to set, kept sealed, and given only to that computer's runtime", async () => {
    expect((await env.call(viewer, "PUT", "/api/computers/pc-on/network", { secret: "http://u:p@proxy.example:3128" })).status).toBe(403);
    expect((await env.call(env.owner, "PUT", "/api/computers/pc-on/network", { secret: "not a proxy" })).status).toBe(400);
    const set = await env.call(env.owner, "PUT", "/api/computers/pc-on/network", { secret: "http://u:p@proxy.example:3128" });
    expect(set.body.network).toEqual({ mode: "proxy", secretSet: true });
    expect(JSON.stringify(set.body)).not.toContain("u:p@");
    const own = await env.service.kernel.identity.issueComputerToken("pc-on");
    expect((await inject("GET", "/api/browser/network", own)).body).toEqual({ mode: "proxy", proxy: "http://u:p@proxy.example:3128" });
    expect((await inject("GET", "/api/browser/network", env.owner)).status).toBe(403);
  });

  it("pairing a machine: one command, a link that works once, its own token, health on the computer; forgetting it cuts it off", async () => {
    expect((await env.call(env.owner, "POST", "/api/computers/pc-on/pair")).status).toBe(409); // not set to remote
    const pair = (await env.call(env.owner, "POST", "/api/computers/pc-far/pair")).body;
    // No temporary address here: the link is on this server's direct port, its key pinned in the command.
    expect(pair.command).toBe(`curl -fsSLk --pinnedpubkey 'sha256//PIN' '${pair.url}' | sudo bash`);
    expect(pair.url).toMatch(/^https:\/\/203\.0\.113\.5:7443\/pair\/apr_[\w-]+$/);
    expect(pair.routes).toContainEqual({ address: "203.0.113.5:7443", kind: "public" });
    const path = new URL(pair.url).pathname;
    // Never on the address people open Agentown at.
    expect((await inject("GET", path)).status).toBe(404);
    // The direct port (and the temporary address) answer it.
    const port = http.createServer((req, res) => void env.instance.computers!.servePair(req, res, "https://203.0.113.5:7443"));
    await new Promise<void>((r) => port.listen(0, "127.0.0.1", r));
    const at = `http://127.0.0.1:${(port.address() as AddressInfo).port}${path}`;
    const script = await fetch(at).then(async (r) => ({ status: r.status, text: await r.text() }));
    expect(script.status).toBe(200);
    expect(script.text).toContain("docker run");
    expect(script.text).toContain("ROUTES='");
    expect(script.text).toContain("203.0.113.5:7443");
    expect(script.text).toContain("-e HOME=/workspace/home"); // Chromium crashes without a writable home
    // It checks Agentown answers directly (key pinned) before anything is set up or the link is used.
    expect(script.text.indexOf('--pinnedpubkey "sha256//$PIN"')).toBeLessThan(script.text.indexOf("/claim"));
    const post = (body: unknown) => fetch(`${at}/claim`, { method: "POST", body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
    const claim = await post({ host: "studio-box", os: "Linux 6.8", arch: "x86_64", cpus: 8, memoryMb: 16000 });
    expect(claim.body.image).toMatch(/^agentown\/browser/);
    expect((await post({})).status).toBe(404); // once
    expect((await fetch(at)).status).toBe(404);
    port.close();
    const token = claim.body.token as string;
    expect((await inject("GET", "/api/browser/network", token)).body).toEqual({ mode: "direct" }); // a paired machine browses directly

    const b = await bridge(token);
    b.ws.send(JSON.stringify({ agentown: "health", host: "studio-box", os: "Linux 6.8", cpus: 8, load: [0.5, 0.4, 0.3], memory: { total: 16e9, free: 8e9 } }));
    await until(async () => false);
    const status = (await env.call(env.owner, "GET", "/api/computers/pc-far")).body;
    expect(status).toMatchObject({ connected: true, remote: { machine: { host: "studio-box", cpus: 8 } }, health: { host: "studio-box", cpus: 8 } });

    await env.call(env.owner, "DELETE", "/api/computers/pc-far/pair");
    expect((await env.call(env.owner, "GET", "/api/computers/pc-far")).body.remote.machine).toBeNull();
    expect((await inject("GET", "/api/browser/network", token)).status).toBeGreaterThanOrEqual(401);
  });

  it("viewers that decode H.264 get the computer's own video, sized for them; others get JPEG frames", async () => {
    const token = await env.service.kernel.identity.issueComputerToken("pc-old");
    const b = await bridge(token);
    await until(() => env.instance.computers!.list(env.service).find((c) => c.id === "pc-old")?.state === "on");
    const got: Buffer[] = [];
    const said: any[] = [];
    const screen = await env.app.injectWS(`/api/orgs/agentown/computers/pc-old/screen`, { headers: { authorization: `Bearer ${env.owner}` } } as any, {
      onInit: (v) => v.on("message", (d: Buffer, binary: boolean) => (binary ? got.push(d) : said.push(JSON.parse(d.toString())))),
    });
    screen.send(JSON.stringify({ t: "view", w: 400, h: 250, dpr: 2, codec: "h264" }));
    await until(() => b.control.some((m) => m.agentown === "video" && m.on));
    // The screen below the browser's tab strip (1280×760), fitted to its box of 800×500 device pixels.
    expect(b.control.find((m) => m.agentown === "video" && m.on)).toMatchObject({ w: 842, h: 500, fps: 30, top: 40 });
    await until(() => said.some((m) => m.t === "size" && m.h === 760));
    // Its clicks and keys go to the screen itself (below the tab strip), as a person's would.
    screen.send(JSON.stringify({ t: "mouse", type: "mousePressed", x: 100, y: 50, button: "left" }));
    screen.send(JSON.stringify({ t: "key", type: "keyDown", key: "a", modifiers: 2 }));
    await until(() => b.control.filter((m) => m.agentown === "input").length === 2);
    expect(b.control.filter((m) => m.agentown === "input")).toEqual([
      expect.objectContaining({ t: "mouse", type: "mousePressed", x: 100, y: 90, button: "left" }),
      expect.objectContaining({ t: "key", type: "keyDown", key: "a", modifiers: 2 }),
    ]);
    const au = Buffer.from([1, 0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x65, 0x88]);
    b.ws.send(au);
    await until(() => got.length);
    expect(got[0]).toEqual(au);
    screen.terminate();
    await until(() => b.control.some((m) => m.agentown === "video" && !m.on));
    expect(b.control.at(-1)).toMatchObject({ agentown: "video", on: false });
  });

  it("terminal: a command runs in the computer's own container and its output comes back; never beside a proxy or VPN", async () => {
    const token = await env.service.kernel.identity.issueComputerToken("pc-term");
    const b = await bridge(token);
    await until(() => env.instance.computers!.list(env.service).find((c) => c.id === "pc-term")?.state === "on");
    const r = await env.call(env.owner, "POST", "/api/computers/pc-term/requests", { app: "terminal", action: "run", command: "echo hi" });
    expect(r.body).toMatchObject({ status: "done", result: "exit 0\nran: echo hi\n" });
    expect(b.control).toContainEqual(expect.objectContaining({ agentown: "run", command: "echo hi" }));
    // A computer without the app refuses.
    expect((await env.call(env.owner, "POST", "/api/computers/pc-on/requests", { app: "terminal", action: "run", command: "id" })).status).toBe(400);
    // Its shell could read what its runtime holds: a terminal computer browses directly.
    const old = await env.call(env.owner, "GET", "/api/world");
    const objects = old.body.world.objects.map((o: { id: string }) => (o.id === "pc-term" ? { ...o, computer: { studio: true, apps: ["terminal"], network: "vpn" } } : o));
    expect((await env.call(env.owner, "PUT", "/api/world", { revision: old.body.revision, world: { ...old.body.world, objects } })).status).toBe(400);
    b.ws.terminate();
  });

  it("a computer looks at a picture of its own: read through its terminal as a small JPEG, then its model looks", async () => {
    const l = await bridge(await env.service.kernel.identity.issueComputerToken("pc-look"));
    await until(() => env.instance.computers!.list(env.service).find((c) => c.id === "pc-look")?.state === "on");
    for (const path of ["/etc/passwd", "/workspace/../etc/x.jpg", "/workspace/it's.jpg"]) {
      expect((await env.call(env.owner, "POST", "/api/computers/pc-look/requests", { app: "terminal", action: "look", path })).status).toBe(400);
    }
    const look = await env.call(env.owner, "POST", "/api/computers/pc-look/requests", { app: "terminal", action: "look", path: "/workspace/remake/a/ref/sheet.jpg" });
    expect(look.body.message).toContain("could not read /workspace/remake/a/ref/sheet.jpg as a picture");
    expect(l.control.some((m) => m.agentown === "run" && m.command.startsWith("ffmpeg ") && m.command.includes("'/workspace/remake/a/ref/sheet.jpg'") && m.command.endsWith("| base64 -w0"))).toBe(true);
    l.ws.terminate();
  });

  it("a workstation is its person's own computer once its studio computer is on", async () => {
    const list = (await env.call(env.owner, "GET", "/api/computers")).body.computers;
    // Named after its person, or by its own name.
    expect(list.find((c: { id: string }) => c.id === "desk:lead-eng")).toMatchObject({ name: "PC · Linh", apps: ["browser", "terminal"] });
    expect(list.find((c: { id: string }) => c.id === "desk:ceo")).toMatchObject({ name: "Ava's laptop" });
    expect((await env.call(env.owner, "GET", `/api/computers/${encodeURIComponent("desk:lead-eng")}`)).status).toBe(200);
    expect((await env.call(env.owner, "GET", `/api/computers/${encodeURIComponent("desk:po")}`)).status).toBe(404); // studio off: just a PC on the desk
  });
});
