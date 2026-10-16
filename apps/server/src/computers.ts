import { type Actor, type Computer as ComputerSettings, computerOf, type ObjectKind } from "@agentown/core";
import type http from "node:http";
import { z } from "zod";
import { createChatModel } from "./chat/provider.ts";
import { chatConfigSchema, type ChatModelFactory, type ChatTool, type Message } from "./chat/types.ts";
import { callConnector, connectorTools } from "./connectors.ts";
import type { Instance } from "./instance.ts";
import { classify } from "./runtime/controller.ts";
import type { RuntimeDriver, RuntimeSpec } from "./runtime/driver.ts";
import { namespaceFor, type Service } from "./service.ts";
import { PairTunnel } from "./pair-tunnel.ts";
import { type RemotePort, routesOf } from "./remote-port.ts";
import { ApiError, badRequest, conflict, deny, newId, newSecret, notFound, sha256 } from "./util.ts";

/**
 * The world's computers. Each placed object whose kind has `browser` is one
 * Chromium with a screen, run as a pod from the catalog's browser image. The pod
 * dials out to /api/browser/bridge and carries the DevTools protocol over that
 * one socket; through it agents drive the page (open, look, click, type) and
 * people watch the screen and take over, e.g. to log in. A computer starts when
 * first used and stops after IDLE_MS with nobody using or watching it; its
 * profile (logins, cookies) lives on the pod's volume and survives restarts.
 *
 * A computer also waits for requests like an agent, one at a time (computer_requests):
 * from agents, from people chatting with it, or from its own camera. It does them with
 * its apps (computer.apps): browser, mcp (the connectors attached to it), stream (a video
 * in a tab of its own) and camera (a feed it watches). Requests in words go to a small
 * model loop with those apps as tools. Its screen shows one app at a time.
 */

/** The part of a WebSocket (ws) this module uses. */
export interface Sock {
  send(data: string | Buffer): void;
  /** Bytes queued but not yet sent: a slow link's frames are skipped, not queued. */
  bufferedAmount?: number;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (data: Buffer, binary?: boolean) => void): void;
  on(event: "close", fn: () => void): void;
  readyState: number;
}

const IDLE_MS = 15 * 60_000;
const BOOT_MS = 120_000;
const UNSCHEDULABLE_MS = 45_000;
const CALL_MS = 30_000;
/** A viewer whose link has this much unsent gets no new frame until it catches up (latest wins, no lag). */
const BACKLOG_BYTES = 384_000;
/** A pairing link (the one command another machine runs) stays valid this long, once. */
const PAIR_MS = 15 * 60_000;
const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
const SNAPSHOT_CHARS = 15_000;
/** Camera: how different two small frames must be (0–255 per channel) to count as a change, and quiet time after a report. */
const CHANGE = 12;
const REPORT_QUIET_MS = 5 * 60_000;
/** A computer's id as Kubernetes names and labels take it ("desk:a-1" → "desk-a-1"). */
const kubeName = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]/g, "-");
/** Someone's workstation as a computer: "desk:<agent id>" (its settings in world.desks). */
const DESK = "desk:";
const DESK_KIND = { name: "PC", category: "static", look: { parts: [] }, behaviors: [], access: "own-room", states: [], actions: [], browser: {} } as unknown as ObjectKind;
type Placed = NonNullable<Service["config"]["world"]>["objects"][number];
/** The page a browser opens first when its computer names none. */
const DEFAULT_HOME = "https://www.google.com";
const SCREEN_APPS = ["browser", "stream", "camera", "terminal"] as const;
/** The terminal app: a page the computer's own runtime serves to its browser (inside its container only). */
const TERMINAL_URL = "http://127.0.0.1:7681/";
/** The browser window's tab strip (screen rows): its video starts below it, at the address bar. */
const TAB_STRIP = 40;
type ScreenApp = (typeof SCREEN_APPS)[number];

interface Page {
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
}

type Call = { ok: (v: any) => void; fail: (e: Error) => void; timer: NodeJS.Timeout };

class Computer {
  bridge: Sock | null = null;
  pages: Page[] = [];
  attaching = new Set<string>();
  viewers = new Set<Sock>();
  /** Element refs from the last look ("e12" → DOM node), valid until the next look. */
  refs = new Map<string, number>();
  calls = new Map<number, Call>();
  seq = 0;
  wanted = false;
  usedAt = Date.now();
  generation = 1;
  state: "off" | "starting" | "on" | "error" = "off";
  detail: string | null = null;
  waiting: Array<() => void> = [];
  /** The CDP session whose screen streams to viewers, and at what size (as big as the biggest viewer needs). */
  casting: string | null = null;
  castSize = "";
  /** Each viewer's screen box (CSS px × device pixels, at most 2×), so frames are no bigger than shown, and how it decodes. */
  views = new Map<Sock, { w: number; h: number; codec: "h264" | "jpeg" }>();
  /** The H.264 video the computer sends now ("WxH", or "" when none). */
  videoSize = "";
  /** What its runtime last said about itself (machine, load, memory), when, and the round trip to it. */
  health: Record<string, unknown> | null = null;
  healthAt = 0;
  rtt: number | null = null;
  seenSaved = 0;
  /** The page size frames are of (for viewers mapping their clicks). */
  frameSize = { w: 1280, h: 800 };
  loads = new Map<string, Array<() => void>>();
  /** Since when its pod has found no machine with room. */
  unschedulable: number | null = null;
  /** The stream, camera and terminal apps' windows (target ids); every other tab is the browser's. */
  apps = new Map<ScreenApp, string>();
  /** Gone from its world (its runtime torn down once). */
  removed = false;
  /** Terminal commands sent to its runtime, waiting for their output. */
  runs = new Map<string, { done: (m: Record<string, unknown>) => void; fail: (e: Error) => void }>();
  /** The app on its screen. */
  showing: ScreenApp = "browser";
  /** Camera watch: when it last looked, that small frame, and no reports until. */
  lookedAt = 0;
  frame: string | null = null;
  quietUntil = 0;
  constructor(
    readonly orgId: string,
    readonly objectId: string,
  ) {}
  /** The browser's tabs, the front one last. */
  get tabs() {
    const own = new Set(this.apps.values());
    return this.pages.filter((p) => !own.has(p.targetId));
  }
  /** The browser's front tab. */
  get page() {
    return this.tabs.at(-1) ?? null;
  }
  /** What its screen shows. */
  get shown() {
    return (this.showing !== "browser" && this.pages.find((p) => p.targetId === this.apps.get(this.showing))) || this.page;
  }
}

/** What a computer can be asked: in words (its model decides), or exactly, for one app. */
export const computerRequestSchema = z.union([
  z.object({ app: z.literal("terminal"), action: z.literal("run"), command: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ app: z.literal("screen"), show: z.enum(SCREEN_APPS) }).strict(),
  z.object({ app: z.literal("mcp"), action: z.literal("tools"), connector: z.string().min(1).max(64) }).strict(),
  z.object({ app: z.literal("mcp"), action: z.literal("call"), connector: z.string().min(1).max(64), tool: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()).default({}) }).strict(),
  z.object({ app: z.literal("stream"), action: z.enum(["play", "stop"]), url: z.string().max(1000).optional() }).strict(),
  z.object({ app: z.literal("camera"), action: z.literal("look"), question: z.string().max(1000).optional() }).strict(),
  z.object({ app: z.literal("browser"), action: z.enum(["look", "open", "click", "type", "key", "scroll", "back", "tab"]) }).passthrough(),
]);
export type ComputerRequest = z.infer<typeof computerRequestSchema>;

export type BrowserAction =
  | { action: "look" }
  | { action: "open"; url: string }
  | { action: "click"; ref?: string; x?: number; y?: number }
  | { action: "type"; text: string; ref?: string; submit?: boolean }
  | { action: "key"; key: string }
  | { action: "scroll"; dy?: number }
  | { action: "back" }
  | { action: "tab"; index: number };

/** Roles an agent can act on: they get a ref in a look. */
const INTERACTIVE = new Set(["link", "button", "textbox", "searchbox", "combobox", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "switch", "slider", "spinbutton", "listbox", "treeitem"]);
/** Interactive roles whose children are more of them (a list's options); others say everything in their name. */
const CONTAINERS = new Set(["listbox", "combobox", "menu", "menubar", "tablist", "radiogroup", "tree", "grid"]);
const TEXT = new Set(["StaticText", "heading", "image", "img", "cell", "columnheader", "rowheader", "alert", "status", "dialog"]);

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  Space: { code: "Space", keyCode: 32, text: " " },
};
export const BROWSER_KEYS = Object.keys(KEYS);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One readable line from a driver error (the Kubernetes API puts its reason in the body). */
function why(err: unknown): string {
  try {
    const m = JSON.parse(String((err as { body?: unknown }).body)).message;
    if (m) return String(m).slice(0, 300);
  } catch {}
  return String((err as Error)?.message ?? err).split("\n")[0]!.slice(0, 300);
}

/** What a person typed in the address bar, as a URL. */
export function toUrl(raw: string): string {
  const s = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return /^[^\s/]+\.[^\s]+/.test(s) || s.startsWith("localhost") ? `https://${s}` : `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export class Computers {
  private readonly all = new Map<string, Computer>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** Each computer's requests, chained so they run one at a time. */
  private readonly queues = new Map<string, Promise<unknown>>();
  private watching = false;
  private readonly factory: ChatModelFactory;

  constructor(
    private readonly instance: Instance,
    private readonly driver: RuntimeDriver | null,
    private readonly opts: {
      apiUrl: string;
      log?: (msg: string, extra?: Record<string, unknown>) => void;
      chatModelFactory?: ChatModelFactory;
      /** cloudflared, for pairing links on a temporary address (none: links use this server's own address). */
      cloudflared?: string | null;
      /** The port paired machines reach this server on directly (TLS, its key pinned). */
      remote?: RemotePort | null;
    },
  ) {
    this.factory = opts.chatModelFactory ?? createChatModel;
    this.tunnel = opts.cloudflared ? new PairTunnel(opts.cloudflared, (req, res) => void this.servePair(req, res, this.tunnel!.url!), (m) => opts.log?.(m)) : null;
  }
  private readonly tunnel: PairTunnel | null;

  start() {
    // Requests in flight when the server stopped will not finish.
    void this.instance.db.query("UPDATE computer_requests SET status='failed', result='the server restarted', finished_at=now() WHERE status IN ('queued','running')").catch(() => {});
    this.timer = setInterval(() => {
      void this.reconcile();
      void this.watchCameras();
      for (const c of this.all.values()) if (c.bridge?.readyState === 1) c.bridge.send(JSON.stringify({ agentown: "ping", t: Date.now() }));
    }, 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.tunnel?.stop();
    for (const c of this.all.values()) c.bridge?.close();
  }

  private get(orgId: string, objectId: string) {
    const key = `${orgId}/${objectId}`;
    let c = this.all.get(key);
    if (!c) this.all.set(key, (c = new Computer(orgId, objectId)));
    return c;
  }

  /** The computer (a placed one, or someone's workstation "desk:<agent id>"), its kind and where its pod runs. */
  where(service: Service, objectId: string) {
    const world = service.config.world;
    const desk = objectId.startsWith(DESK) ? world?.desks?.[objectId.slice(DESK.length)] : undefined;
    const object = desk ? ({ id: objectId, kind: "workstation", room: "", at: [0, 0] } as unknown as Placed) : world?.objects.find((x) => x.id === objectId);
    const kind = desk ? DESK_KIND : object && world!.kinds[object.kind];
    const computer = desk ? (desk.studio ? desk : null) : computerOf(kind, object);
    if (!object || !kind || !computer) throw notFound("computer");
    const room = world!.floors.flatMap((f) => f.rooms).find((r) => r.id === object.room);
    const department = room?.department ?? service.config.departments[0]!.id;
    return {
      object,
      kind,
      computer,
      preset: service.config.runtimeCatalog.find((p) => p.harness === "browser") ?? null,
      // Each its own runtime (and profile, and storage), named after it.
      runtimeId: `pc-${kubeName(objectId)}-${sha256(service.orgId).slice(0, 6)}`,
      namespace: service.runtimeNamespace ?? namespaceFor(department),
    };
  }

  /** Every computer of a world that runs: placed ones, then workstations (named after their person when known). */
  private entries(service: Service, people = new Map<string, { name: string; room: string }>()) {
    const world = service.config.world;
    const placed = (world?.objects ?? []).flatMap((o) => {
      const computer = o.id ? computerOf(world!.kinds[o.kind], o) : null;
      return computer ? [{ id: o.id!, name: o.label ?? world!.kinds[o.kind]!.name, room: o.room, computer: computer as ComputerSettings }] : [];
    });
    const desks = Object.entries(world?.desks ?? {}).flatMap(([agentId, d]) =>
      d.studio ? [{ id: `${DESK}${agentId}`, name: d.label ?? people.get(agentId)?.name ?? DESK_KIND.name, room: people.get(agentId)?.room ?? "", computer: d as ComputerSettings }] : [],
    );
    return [...placed, ...desks];
  }

  /** The world's computers, workstations named after their people. */
  async listAll(service: Service) {
    const rooms = service.config.world?.floors.flatMap((f) => f.rooms) ?? [];
    const { rows } = await service.db.query<{ id: string; display_name: string; department_id: string }>(
      "SELECT id, display_name, department_id FROM agents WHERE org_id=$1 AND lifecycle_state <> 'retired'",
      [service.orgId],
    );
    const people = new Map(rows.map((a) => [a.id, { name: `${DESK_KIND.name} · ${a.display_name}`, room: rooms.find((r) => r.department === a.department_id)?.id ?? "" }]));
    return this.list(service, people);
  }

  /** The world's computers with what each is doing, for the office and agents. */
  list(service: Service, people?: Map<string, { name: string; room: string }>) {
    return this.entries(service, people).map(({ id, name, room, computer }) => {
      const c = this.all.get(`${service.orgId}/${id}`);
      return { id, name, room, apps: computer.apps, connectors: computer.connectors, showing: c?.showing ?? "browser", state: c?.state ?? "off", detail: c?.detail ?? null, url: c?.page?.url ?? null, title: c?.page?.title ?? null, watching: c?.viewers.size ?? 0 };
    });
  }

  async status(service: Service, objectId: string) {
    const { computer } = this.where(service, objectId);
    const c = this.all.get(`${service.orgId}/${objectId}`);
    const machine = (await service.db.query("SELECT host, os, arch, cpus, memory_mb, paired_at, last_seen_at FROM computer_machines WHERE org_id=$1 AND object_id=$2", [service.orgId, objectId])).rows[0] ?? null;
    const secret = (await service.db.query("SELECT updated_at FROM computer_secrets WHERE org_id=$1 AND object_id=$2", [service.orgId, objectId])).rows[0];
    return {
      ...this.list(service).find((x) => x.id === objectId)!,
      connected: !!c?.bridge,
      health: c?.health ? { ...c.health, at: new Date(c.healthAt).toISOString(), rtt: c.rtt } : null,
      network: { mode: computer.network ?? "direct", secretSet: !!secret },
      remote: computer.remote ? { machine } : null,
    };
  }

  /** Want the computer on; resolves once its browser is connected. */
  async ready(service: Service, objectId: string): Promise<Computer> {
    const w = this.where(service, objectId);
    if (w.computer.remote && !this.all.get(`${service.orgId}/${objectId}`)?.bridge) {
      throw new ApiError(503, "machine_offline", "the paired machine is not connected (it reconnects by itself once it is up)");
    }
    if (!w.preset && !w.computer.remote) throw new ApiError(503, "no_browser_image", "this install has no browser image: add a runtimeCatalog preset with harness: browser");
    if (service.runState === "paused" || service.runState === "starting") throw new ApiError(409, "org_paused", "the organization is paused: play it to use its computers");
    const c = this.get(service.orgId, objectId);
    c.wanted = true;
    c.usedAt = Date.now();
    if (c.state === "on" && c.page) return c;
    if (c.state === "error") c.state = "off";
    void this.reconcile();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new ApiError(504, "computer_timeout", `computer ${objectId} did not start in time${c.detail ? ` (${c.detail})` : ""}`)), BOOT_MS);
      c.waiting.push(() => {
        clearTimeout(timer);
        if (c.state === "on") resolve();
        else reject(new ApiError(503, "computer_failed", `computer ${objectId} could not start: ${c.detail ?? "unknown error"}`));
      });
    });
    return c;
  }

  /** Turn a computer off now (its profile stays). */
  async shutDown(service: Service, objectId: string) {
    this.where(service, objectId);
    const c = this.get(service.orgId, objectId);
    c.wanted = false;
    await this.reconcile();
    return this.status(service, objectId);
  }

  /** Tell watchers the state; those waiting for the computer hear once it is on (or cannot be). */
  private settle(c: Computer) {
    if (c.state !== "starting") for (const f of c.waiting.splice(0)) f();
    this.broadcast(c, { t: "status", state: c.state, detail: c.detail });
  }

  // ------------------------------------------------------------ pods

  async reconcile() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const [key, c] of this.all) {
        try {
          await this.reconcileOne(c);
        } catch (err) {
          this.opts.log?.("computer reconcile failed", { key, err: String(err).slice(0, 300) });
          // Say why (a full quota, say) to whoever waits, instead of letting them time out.
          if (c.wanted && c.state !== "on") {
            c.state = "error";
            c.detail = why(err);
            c.wanted = false;
            this.settle(c);
          }
        }
        if (!c.wanted && c.state === "off" && !c.viewers.size) this.all.delete(key);
      }
    } finally {
      this.busy = false;
    }
  }

  private async reconcileOne(c: Computer) {
    if (c.wanted && !c.viewers.size && Date.now() - c.usedAt > IDLE_MS) c.wanted = false;
    let service: Service;
    let w: ReturnType<Computers["where"]>;
    try {
      service = await this.instance.org(c.orgId);
      w = this.where(service, c.objectId);
      if (service.runState === "paused" || service.runState === "starting") c.wanted = false; // a paused organization's computers go off (their profiles stay)
    } catch {
      c.wanted = false; // the object (or its organization) is gone: so is its runtime (its storage stays)
      c.bridge?.close();
      c.state = "off";
      const service = await this.instance.org(c.orgId).catch(() => null);
      if (service && this.driver && !c.removed) {
        c.removed = true;
        const ns = service.runtimeNamespace ?? namespaceFor(service.config.departments[0]!.id);
        const runtimeId = `pc-${kubeName(c.objectId)}-${sha256(c.orgId).slice(0, 6)}`;
        for (const pod of await this.driver.listPods(ns, runtimeId).catch(() => [])) await this.driver.deletePod(ns, pod.name).catch(() => {});
        await this.driver.teardown(ns, runtimeId, false).catch(() => {});
      }
      return;
    }
    c.removed = false;
    if (w.computer.remote) {
      // It runs on a paired machine: no pod here (one left from before goes); on while that machine is connected.
      if (this.driver) for (const p of (await this.driver.listPods(w.namespace, w.runtimeId)).filter((x) => !x.terminating)) await this.driver.deletePod(w.namespace, p.name);
      if (!c.bridge && c.state !== "off") {
        c.state = "off";
        c.detail = "the paired machine is not connected";
        this.settle(c);
      }
      return;
    }
    if (!this.driver || !w.preset) {
      if (c.wanted) {
        c.state = "error";
        c.detail = !this.driver ? "this install runs no runtime driver" : "no browser image in the runtime catalog";
        c.wanted = false;
        this.settle(c);
      }
      return;
    }
    const pods = (await this.driver.listPods(w.namespace, w.runtimeId)).filter((p) => !p.terminating);
    if (!c.wanted) {
      for (const p of pods) await this.driver.deletePod(w.namespace, p.name);
      if (c.state !== "off" && c.state !== "error") {
        c.state = "off";
        c.bridge?.close();
        this.settle(c);
      }
      return;
    }
    for (const p of pods.filter((p) => p.phase === "Failed" || p.phase === "Succeeded")) {
      await this.driver.deletePod(w.namespace, p.name);
      c.generation++;
    }
    const current = pods.find((p) => p.phase !== "Failed" && p.phase !== "Succeeded");
    if (!current) {
      const spec: RuntimeSpec = {
        runtimeId: w.runtimeId,
        teamId: `computer-${kubeName(c.objectId)}`,
        generation: c.generation,
        namespace: w.namespace,
        preset: w.preset,
        resources: w.preset.resources,
        apiUrl: this.opts.apiUrl,
        storageRef: `${w.runtimeId}-workspace`,
        displayName: w.object.label ?? w.kind.name,
      };
      await this.driver.ensureIdentity(spec, () => service.kernel.identity.issueComputerToken(c.objectId));
      const name = await this.driver.createPod(spec);
      this.opts.log?.("started computer", { orgId: c.orgId, objectId: c.objectId, pod: name });
      if (c.state !== "starting") {
        c.state = "starting";
        c.detail = null;
        this.settle(c);
      }
      return;
    }
    const { state, detail } = classify(current);
    // No machine has room for it: say so soon rather than leave everyone waiting.
    const stuck = current.phase === "Pending" && current.waitingReason === "Unschedulable";
    c.unschedulable = stuck ? (c.unschedulable ?? Date.now()) : null;
    if (stuck && Date.now() - c.unschedulable! > UNSCHEDULABLE_MS) {
      await this.driver.deletePod(w.namespace, current.name);
      c.unschedulable = null;
      c.state = "error";
      c.detail = `no machine has room for this computer (${current.message ?? "insufficient resources"}); turn another computer off or free some CPU/memory, then try again`;
      c.wanted = false;
      this.settle(c);
      return;
    }
    if (state === "failed") {
      await this.driver.deletePod(w.namespace, current.name);
      c.state = "error";
      c.detail = detail;
      c.wanted = false;
      this.settle(c);
    } else if (c.state !== "on" && detail !== c.detail) {
      c.state = "starting";
      c.detail = detail;
      this.broadcast(c, { t: "status", state: c.state, detail });
    }
  }

  // ------------------------------------------------------------ the bridge (DevTools protocol)

  /** A computer's pod connected: take over its browser. */
  async attachBridge(orgId: string, objectId: string, sock: Sock) {
    const c = this.get(orgId, objectId);
    c.bridge?.close(4000, "replaced");
    c.bridge = sock;
    c.wanted = true;
    c.usedAt = Date.now();
    c.pages = [];
    c.casting = null;
    c.apps.clear();
    c.showing = "browser";
    c.videoSize = ""; // a new runtime has no video yet: recast asks for it
    sock.on("message", (d, binary) => (binary ? this.onVideo(c, d) : this.onMessage(c, d)));
    sock.on("close", () => {
      if (c.bridge !== sock) return;
      c.bridge = null;
      c.pages = [];
      c.casting = null;
      for (const [, call] of c.calls) call.fail(new ApiError(503, "computer_offline", "the computer went offline"));
      for (const [, run] of c.runs) run.fail(new ApiError(503, "computer_offline", "the computer went offline"));
      c.runs.clear();
      c.calls.clear();
      if (c.state === "on") {
        c.state = c.wanted ? "starting" : "off";
        this.settle(c);
      }
    });
    try {
      await this.cdp(c, "Target.setDiscoverTargets", { discover: true });
      const { targetInfos } = await this.cdp(c, "Target.getTargets");
      for (const t of targetInfos) if (t.type === "page") await this.attachPage(c, t);
      // App windows from before the server restarted are not known as apps any more: close them (apps reopen theirs).
      const computer = await this.instance.org(orgId).then((v) => this.where(v, objectId).computer).catch(() => null);
      const appUrls = [computer?.camera?.url, computer?.stream].filter((u): u is string => !!u).map((u) => this.playable(u, c));
      for (const page of [...c.pages]) {
        if (!page.url.startsWith(`${this.opts.apiUrl}/player?`) && !page.url.includes("/api/browser/player?src=") && !page.url.startsWith(TERMINAL_URL) && !appUrls.includes(page.url)) continue;
        c.pages = c.pages.filter((x) => x !== page);
        await this.cdp(c, "Target.closeTarget", { targetId: page.targetId }).catch(() => {});
      }
      // The browser has one tab: keep the newest.
      for (const extra of c.tabs.slice(0, -1)) {
        c.pages = c.pages.filter((x) => x !== extra);
        await this.cdp(c, "Target.closeTarget", { targetId: extra.targetId }).catch(() => {});
      }
      if (!c.pages.length) await this.attachPage(c, { targetId: (await this.cdp(c, "Target.createTarget", { url: "about:blank" })).targetId, url: "about:blank", title: "" });
      const home = await this.homeOf(orgId, objectId).catch(() => null);
      if (home && c.page!.url === "about:blank") await this.navigate(c, home);
      c.state = "on";
      c.detail = null;
      this.settle(c);
      await this.recast(c);
    } catch (err) {
      this.opts.log?.("computer bridge failed", { orgId, objectId, err: String(err).slice(0, 300) });
      sock.close(1011, "setup failed");
    }
  }

  private async homeOf(orgId: string, objectId: string) {
    const service = await this.instance.org(orgId);
    return this.where(service, objectId).computer.home ?? DEFAULT_HOME;
  }

  private cdp(c: Computer, method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    const bridge = c.bridge;
    if (!bridge) return Promise.reject(new ApiError(503, "computer_offline", "the computer is not connected"));
    const id = ++c.seq;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        c.calls.delete(id);
        fail(new ApiError(504, "computer_timeout", `${method} took too long`));
      }, CALL_MS);
      c.calls.set(id, { ok, fail, timer });
      bridge.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  private onMessage(c: Computer, raw: Buffer) {
    let m: any;
    try {
      m = JSON.parse(raw.toString("utf8"));
    } catch {
      return;
    }
    if (m.agentown) return void this.onControl(c, m);
    if (m.id) {
      const call = c.calls.get(m.id);
      if (!call) return;
      c.calls.delete(m.id);
      clearTimeout(call.timer);
      const msg = String(m.error?.message ?? "browser error");
      if (m.error) call.fail(new ApiError(502, "browser_error", /crashed/i.test(msg) ? "the page crashed (too heavy for this computer); its tab was closed: open it again or try a lighter page" : msg));
      else call.ok(m.result ?? {});
      return;
    }
    const p = m.params ?? {};
    switch (m.method) {
      case "Target.targetCreated":
        if (p.targetInfo?.type === "page" && c.state === "on") void this.attachPage(c, p.targetInfo).then(() => this.recast(c)).catch(() => {});
        break;
      case "Target.targetDestroyed": {
        const before = c.shown?.targetId;
        c.pages = c.pages.filter((x) => x.targetId !== p.targetId);
        for (const [app, id] of c.apps) if (id === p.targetId) c.apps.delete(app);
        if (before !== c.shown?.targetId) void this.recast(c).catch(() => {});
        break;
      }
      case "Target.targetInfoChanged": {
        const page = c.pages.find((x) => x.targetId === p.targetInfo?.targetId);
        if (page) {
          page.url = p.targetInfo.url;
          page.title = p.targetInfo.title;
          if (page === c.shown) this.broadcastPage(c);
          // The browser has one tab: a link that opened another one (or a popup) is followed there instead.
          const tabs = c.tabs;
          if (tabs.length > 1 && tabs.includes(page) && page !== tabs[0] && /^https?:/i.test(page.url)) void this.foldIfSameWindow(c, page).catch(() => {});
        }
        break;
      }
      case "Inspector.targetCrashed": {
        // A tab ran out of memory (a heavy site): close it so the computer stays usable.
        const page = c.pages.find((x) => x.sessionId === m.sessionId);
        if (page) void this.closeCrashed(c, page).catch(() => {});
        break;
      }
      case "Page.loadEventFired":
        for (const f of c.loads.get(m.sessionId)?.splice(0) ?? []) f();
        break;
      case "Page.screencastFrame": {
        void this.cdp(c, "Page.screencastFrameAck", { sessionId: p.sessionId }, m.sessionId).catch(() => {});
        if (m.sessionId !== c.casting) break;
        const w = p.metadata?.deviceWidth, h = p.metadata?.deviceHeight;
        if (w && h && (w !== c.frameSize.w || h !== c.frameSize.h)) {
          c.frameSize = { w, h };
          // JPEG viewers see the page itself; H.264 viewers see the screen (their size comes with the video).
          for (const v of c.viewers) if (c.views.get(v)?.codec !== "h264" && v.readyState === 1) v.send(JSON.stringify({ t: "size", w, h }));
        }
        // Frames go as binary JPEG; a viewer still sending the last ones skips this one.
        const jpeg = Buffer.from(p.data, "base64");
        for (const v of c.viewers) if (v.readyState === 1 && (v.bufferedAmount ?? 0) < BACKLOG_BYTES) v.send(jpeg);
        break;
      }
    }
  }

  private async attachPage(c: Computer, t: { targetId: string; url: string; title: string }) {
    if (c.attaching.has(t.targetId) || c.pages.some((x) => x.targetId === t.targetId)) return;
    c.attaching.add(t.targetId);
    try {
      const { sessionId } = await this.cdp(c, "Target.attachToTarget", { targetId: t.targetId, flatten: true });
      await Promise.all(["Page.enable", "DOM.enable", "Inspector.enable"].map((m) => this.cdp(c, m, {}, sessionId)));
      // The newest page is the one in front (a site opening a login popup, say).
      c.pages.push({ targetId: t.targetId, sessionId, url: t.url, title: t.title });
    } finally {
      c.attaching.delete(t.targetId);
    }
  }

  /** Open a second tab's page in the one tab, and close the second. */
  /** Another tab in the browser's window folds into the one tab; a window of its own (another profile's, a popup) stays. */
  private async foldIfSameWindow(c: Computer, page: Page) {
    const main = c.tabs[0];
    if (!main) return;
    const win = (t: Page) => this.cdp(c, "Browser.getWindowForTarget", { targetId: t.targetId }).then((r) => r.windowId as number).catch(() => null);
    const [a, b] = await Promise.all([win(main), win(page)]);
    if (a !== null && b !== null && a !== b) return;
    await this.foldTab(c, page);
  }

  private async foldTab(c: Computer, extra: Page) {
    const main = c.tabs[0]!;
    c.pages = c.pages.filter((x) => x !== extra);
    await this.cdp(c, "Target.closeTarget", { targetId: extra.targetId }).catch(() => {});
    c.pages = [...c.pages.filter((x) => x !== main), main];
    await this.navigate(c, extra.url, main.sessionId);
    await this.recast(c);
  }

  private async closeCrashed(c: Computer, page: Page) {
    c.pages = c.pages.filter((x) => x !== page);
    for (const [app, id] of c.apps) if (id === page.targetId) c.apps.delete(app);
    await this.cdp(c, "Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    if (!c.tabs.length) await this.cdp(c, "Target.createTarget", { url: "about:blank" });
    await this.recast(c);
  }

  /** Stream the front page to whoever watches (and nothing when nobody does). */
  /** Rows of the screen its video leaves out above: the browser's tab strip (app windows are full screen). */
  private videoTop(c: Computer) {
    return c.showing === "browser" ? TAB_STRIP : 0;
  }

  private async recast(c: Computer) {
    // The size the biggest viewer of each kind needs, in the picture's proportions.
    const top = this.videoTop(c);
    const fit = (vs: Array<{ w: number; h: number }>, ph = 800) => {
      const k = Math.min(1, Math.max(...vs.map((v) => Math.max(v.w / 1280, v.h / ph))));
      return { w: even(1280 * k), h: even(ph * k) };
    };
    const views = [...c.viewers].map((v) => c.views.get(v) ?? { w: 1280, h: 800, codec: "jpeg" as const });
    const jpeg = views.filter((v) => v.codec === "jpeg");
    const h264 = views.filter((v) => v.codec === "h264");
    // What is in front is what the screen (and its video) shows.
    if (c.viewers.size && c.shown) await this.cdp(c, "Page.bringToFront", {}, c.shown.sessionId).catch(() => {});
    // H.264 from the computer itself (its own CPU encodes it), for viewers that decode it.
    // It is the screen itself (below the tab strip): its clicks and keys go to the screen too.
    const video = h264.length ? fit(h264, 800 - top) : null;
    const videoSize = video ? `${video.w}x${video.h}+${top}` : "";
    if (videoSize !== c.videoSize && c.bridge) {
      c.videoSize = videoSize;
      c.bridge.send(JSON.stringify(video ? { agentown: "video", on: true, w: video.w, h: video.h, fps: 30, top } : { agentown: "video", on: false }));
    }
    for (const v of c.viewers) if (c.views.get(v)?.codec === "h264" && v.readyState === 1) v.send(JSON.stringify({ t: "size", w: 1280, h: 800 - top }));
    // JPEG frames over DevTools for the others.
    const want = jpeg.length && c.shown ? c.shown.sessionId : null;
    const { w, h } = jpeg.length ? fit(jpeg) : { w: 1280, h: 800 };
    const size = `${w}x${h}`;
    if (want === c.casting && (!want || size === c.castSize)) return this.broadcastPage(c);
    const old = c.casting;
    c.casting = want;
    c.castSize = size;
    if (old) await this.cdp(c, "Page.stopScreencast", {}, old).catch(() => {});
    if (want) await this.cdp(c, "Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: w, maxHeight: h }, want).catch(() => {});
    this.broadcastPage(c);
  }

  /** H.264 from the computer: to each viewer that decodes it and keeps up (a slow one skips to the next keyframe). */
  private onVideo(c: Computer, au: Buffer) {
    for (const v of c.viewers) {
      if (v.readyState === 1 && c.views.get(v)?.codec === "h264" && (v.bufferedAmount ?? 0) < BACKLOG_BYTES) v.send(au);
    }
  }

  /** What a computer's runtime says about itself (health), and the answer to our ping. */
  private onControl(c: Computer, m: Record<string, unknown>) {
    if (m.agentown === "pong" && typeof m.t === "number") c.rtt = Date.now() - m.t;
    if (m.agentown === "ran" && typeof m.id === "string") {
      c.runs.get(m.id)?.done(m);
      c.runs.delete(m.id);
      return;
    }
    if (m.agentown !== "health") return;
    const { agentown: _, ...h } = m;
    if (JSON.stringify(h).length > 8192) return; // a paired machine says this; keep it small
    c.health = h;
    c.healthAt = Date.now();
    // A paired machine: note when it was last seen (now and then, not on every beat).
    if (Date.now() - c.seenSaved > 60_000) {
      c.seenSaved = Date.now();
      void this.instance.db.query("UPDATE computer_machines SET last_seen_at=now() WHERE org_id=$1 AND object_id=$2", [c.orgId, c.objectId]).catch(() => {});
    }
  }

  private broadcast(c: Computer, msg: unknown) {
    const s = JSON.stringify(msg);
    for (const v of c.viewers) if (v.readyState === 1) v.send(s);
  }

  private broadcastPage(c: Computer) {
    this.broadcast(c, { t: "page", url: c.shown?.url ?? "", title: c.shown?.title ?? "", tabs: c.tabs.length, showing: c.showing });
  }

  // ------------------------------------------------------------ agents

  /** Do one thing on the computer and describe the page after it. */
  async act(service: Service, objectId: string, a: BrowserAction): Promise<string> {
    const c = await this.ready(service, objectId);
    const s = () => c.page!.sessionId;
    switch (a.action) {
      case "open": {
        const url = toUrl(a.url);
        if (!/^https?:\/\//i.test(url) && url !== "about:blank") throw badRequest("only http(s) pages can be opened");
        await this.navigate(c, url);
        break;
      }
      case "click": {
        const [x, y] = a.ref ? await this.point(c, a.ref) : [a.x ?? 0, a.y ?? 0];
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          await this.cdp(c, "Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 }, s());
        }
        await sleep(1200);
        break;
      }
      case "type": {
        if (a.ref) {
          const { object } = await this.cdp(c, "DOM.resolveNode", { backendNodeId: this.ref(c, a.ref) }, s());
          // Focus it and select what is there, so the text replaces it.
          await this.cdp(c, "Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){this.focus(); if (this.select) this.select(); else if (this.isContentEditable) document.execCommand('selectAll');}" }, s());
        }
        await this.cdp(c, "Input.insertText", { text: a.text }, s());
        if (a.submit) await this.press(c, "Enter");
        await sleep(a.submit ? 1500 : 200);
        break;
      }
      case "key":
        await this.press(c, a.key);
        await sleep(600);
        break;
      case "scroll":
        await this.cdp(c, "Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: a.dy ?? 600 }, s());
        await sleep(500);
        break;
      case "back": {
        const h = await this.cdp(c, "Page.getNavigationHistory", {}, s());
        if (h.currentIndex > 0) {
          await this.cdp(c, "Page.navigateToHistoryEntry", { entryId: h.entries[h.currentIndex - 1].id }, s());
          await sleep(1500);
        }
        break;
      }
      case "tab": {
        const page = c.tabs[a.index];
        if (!page) throw badRequest(`there is no tab ${a.index} (tabs: 0–${c.tabs.length - 1})`);
        c.pages = [...c.pages.filter((x) => x !== page), page];
        await this.cdp(c, "Page.bringToFront", {}, page.sessionId);
        await this.recast(c);
        break;
      }
    }
    c.usedAt = Date.now();
    return this.snapshot(c);
  }

  private async navigate(c: Computer, url: string, s = c.page!.sessionId) {
    const loaded = new Promise<void>((r) => {
      const list = c.loads.get(s) ?? [];
      list.push(r);
      c.loads.set(s, list);
      setTimeout(r, 15_000);
    });
    const r = await this.cdp(c, "Page.navigate", { url }, s);
    if (r.errorText) throw new ApiError(502, "navigation_failed", `could not open ${url}: ${r.errorText}`);
    await loaded;
    await sleep(500);
  }

  private async press(c: Computer, key: string) {
    const k = KEYS[key];
    if (!k) throw badRequest(`unknown key ${key}; use one of ${BROWSER_KEYS.join(", ")}`);
    const base = { key: key === "Space" ? " " : key, code: k.code, windowsVirtualKeyCode: k.keyCode };
    await this.cdp(c, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", ...base, ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}) }, c.page!.sessionId);
    await this.cdp(c, "Input.dispatchKeyEvent", { type: "keyUp", ...base }, c.page!.sessionId);
  }

  private ref(c: Computer, ref: string) {
    const id = c.refs.get(ref);
    if (!id) throw badRequest(`unknown ref ${ref}: look at the page again for current refs`);
    return id;
  }

  /** The middle of an element on screen (scrolled into view). */
  private async point(c: Computer, ref: string): Promise<[number, number]> {
    const backendNodeId = this.ref(c, ref);
    const s = c.page!.sessionId;
    await this.cdp(c, "DOM.scrollIntoViewIfNeeded", { backendNodeId }, s).catch(() => {});
    const { quads } = await this.cdp(c, "DOM.getContentQuads", { backendNodeId }, s);
    const q: number[] | undefined = quads?.[0];
    if (!q) throw badRequest(`${ref} is not visible on the page`);
    return [(q[0]! + q[2]! + q[4]! + q[6]!) / 4, (q[1]! + q[3]! + q[5]! + q[7]!) / 4];
  }

  /** The page as text: what it says, and what can be clicked or typed into, each with a ref. */
  private async snapshot(c: Computer): Promise<string> {
    const page = c.page!;
    const { nodes } = await this.cdp(c, "Accessibility.getFullAXTree", {}, page.sessionId);
    const byId = new Map<string, any>(nodes.map((n: any) => [n.nodeId, n]));
    c.refs.clear();
    const lines: string[] = [];
    let n = 0;
    let size = 0;
    const walk = (node: any, depth: number) => {
      if (!node || size > SNAPSHOT_CHARS) return;
      const role: string = node.role?.value ?? "";
      const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim();
      const pad = "  ".repeat(depth);
      let line: string | null = null;
      let into = true;
      if (!node.ignored && INTERACTIVE.has(role) && node.backendDOMNodeId) {
        const ref = `e${++n}`;
        c.refs.set(ref, node.backendDOMNodeId);
        const value = node.value?.value;
        const flags = (node.properties ?? [])
          .filter((p: any) => ["checked", "selected", "expanded", "disabled"].includes(p.name) && p.value?.value && p.value.value !== "false")
          .map((p: any) => (p.value.value === true || p.value.value === "true" ? p.name : `${p.name}=${p.value.value}`));
        line = `${pad}- ${role}${name ? ` "${cut(name, 120)}"` : ""}${value ? ` value="${cut(String(value), 80)}"` : ""}${flags.length ? ` (${flags.join(", ")})` : ""} [${ref}]`;
        into = CONTAINERS.has(role);
      } else if (!node.ignored && TEXT.has(role) && name) {
        line = `${pad}${role === "StaticText" ? "" : `${role}: `}${cut(name, 300)}`;
        into = role !== "heading" && role !== "StaticText";
      }
      if (line) {
        lines.push(line);
        size += line.length + 1;
      }
      if (into) for (const id of node.childIds ?? []) walk(byId.get(id), line ? depth + 1 : depth);
    };
    walk(nodes[0], 0);
    const tabs = c.tabs.length > 1 ? `Tabs: ${c.tabs.map((p, i) => `${i}${p === page ? "*" : ""} ${cut(p.title || p.url, 40)}`).join(" | ")}\n` : "";
    return `Page: ${page.title || "(untitled)"}\nURL: ${page.url}\n${tabs}\n${lines.join("\n")}${size > SNAPSHOT_CHARS ? "\n… (more below: scroll, then look again)" : ""}`;
  }

  // ------------------------------------------------------------ people

  /** Who may watch a computer and use it by hand: the owner, or people who may design the world. */
  async mayWatch(service: Service, actor: Actor) {
    if (actor.kind !== "human") return false;
    if (actor.owner) return true;
    return service.kernel.permissions.allowedAnywhere(actor, "org.design", await service.kernel.permissions.load(), { agentIds: [] });
  }

  /** Someone opened the computer's screen: stream it and pass their mouse and keyboard on. */
  async watch(service: Service, actor: Actor, objectId: string, sock: Sock) {
    if (!(await this.mayWatch(service, actor))) throw deny("only the owner, or people who may design the world, use the computers");
    const c = this.get(service.orgId, objectId);
    c.viewers.add(sock);
    sock.on("close", () => {
      c.viewers.delete(sock);
      c.views.delete(sock);
      c.usedAt = Date.now();
      void this.recast(c).catch(() => {});
    });
    sock.on("message", (d) => void this.input(c, d, sock).catch(() => {}));
    sock.send(JSON.stringify({ t: "status", state: c.state, detail: c.detail }));
    sock.send(JSON.stringify({ t: "size", ...c.frameSize }));
    try {
      await this.ready(service, objectId);
      await this.recast(c);
    } catch (err) {
      sock.send(JSON.stringify({ t: "status", state: "error", detail: (err as Error).message }));
    }
  }

  private async input(c: Computer, raw: Buffer, sock: Sock) {
    const m = JSON.parse(raw.toString("utf8"));
    const num0 = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    if (m.t === "view") {
      // Its screen box: frames come at most as big as that (device pixels, up to 2×), from 320×200.
      const k = Math.min(2, Math.max(1, num0(m.dpr)));
      c.views.set(sock, { w: Math.max(320, Math.round(num0(m.w) * k)), h: Math.max(200, Math.round(num0(m.h) * k)), codec: m.codec === "h264" ? "h264" : "jpeg" });
      return this.recast(c);
    }
    // People use what is on the screen, whichever app it is.
    const s = c.shown?.sessionId;
    if (!s || c.state !== "on") return;
    c.usedAt = Date.now();
    // Watching its video (the screen itself): mouse and keys go to the screen, as a person's would, so the
    // browser's own bar, menus, extensions and profiles work. Watching JPEG frames (the page): to the page.
    if (c.views.get(sock)?.codec === "h264" && ["mouse", "wheel", "key", "text"].includes(m.t) && c.bridge?.readyState === 1) {
      const pick = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => ["string", "number"].includes(typeof v)));
      const { x: px, y: py, ...rest } = pick(m);
      c.bridge.send(JSON.stringify({ agentown: "input", ...rest, ...(m.t === "mouse" || m.t === "wheel" ? { x: num0(px), y: num0(py) + this.videoTop(c) } : {}) }));
      return;
    }
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const mods = num(m.modifiers) & 15;
    switch (m.t) {
      case "mouse":
        if (!["mousePressed", "mouseReleased", "mouseMoved"].includes(m.type)) return;
        return this.cdp(c, "Input.dispatchMouseEvent", { type: m.type, x: num(m.x), y: num(m.y), modifiers: mods, button: m.type === "mouseMoved" ? "none" : ["left", "middle", "right"].includes(m.button) ? m.button : "left", clickCount: Math.min(3, Math.max(1, num(m.clickCount) || 1)) }, s);
      case "wheel":
        return this.cdp(c, "Input.dispatchMouseEvent", { type: "mouseWheel", x: num(m.x), y: num(m.y), deltaX: num(m.dx), deltaY: num(m.dy), modifiers: mods }, s);
      case "key":
        if (!["keyDown", "rawKeyDown", "keyUp"].includes(m.type)) return;
        return this.cdp(c, "Input.dispatchKeyEvent", {
          type: m.type, modifiers: mods, key: String(m.key ?? "").slice(0, 32), code: String(m.code ?? "").slice(0, 32), windowsVirtualKeyCode: num(m.keyCode),
          ...(typeof m.text === "string" && m.text.length <= 4 ? { text: m.text, unmodifiedText: m.text } : {}),
        }, s);
      case "text":
        if (typeof m.text === "string") return this.cdp(c, "Input.insertText", { text: m.text.slice(0, 10_000) }, s);
        return;
      case "go":
        if (typeof m.url === "string") return this.navigate(c, toUrl(m.url), s);
        return;
      case "back":
      case "forward": {
        const h = await this.cdp(c, "Page.getNavigationHistory", {}, s);
        const e = h.entries[h.currentIndex + (m.t === "back" ? -1 : 1)];
        if (e) await this.cdp(c, "Page.navigateToHistoryEntry", { entryId: e.id }, s);
        return;
      }
      case "reload":
        return this.cdp(c, "Page.reload", {}, s);
    }
  }

  // ------------------------------------------------------------ requests (the computer as an agent)

  /** Ask a computer to do something; it does its requests one at a time, in order. Resolves once this one is done. */
  async request(service: Service, objectId: string, requester: string, input: ComputerRequest): Promise<{ id: string; status: "done"; result: string }> {
    const { computer } = this.where(service, objectId);
    if ("app" in input) {
      const app = input.app === "screen" ? input.show : input.app;
      if (!computer.apps.includes(app)) throw badRequest(`this computer has no ${app} app (it has ${computer.apps.join(", ")})`);
      if (input.app === "mcp" && !computer.connectors.includes(input.connector)) {
        throw badRequest(`connector ${input.connector} is not attached to this computer (attached: ${computer.connectors.join(", ") || "none"})`);
      }
    }
    const id = newId("cr");
    await service.db.query("INSERT INTO computer_requests(id, org_id, object_id, requester, app, input) VALUES ($1,$2,$3,$4,$5,$6)", [
      id, service.orgId, objectId, requester, "app" in input ? input.app : null, JSON.stringify(input),
    ]);
    const key = `${service.orgId}/${objectId}`;
    const run = (this.queues.get(key) ?? Promise.resolve()).then(async () => {
      await service.db.query("UPDATE computer_requests SET status='running', started_at=now() WHERE id=$1", [id]);
      try {
        const result = await this.perform(service, objectId, input);
        await service.db.query("UPDATE computer_requests SET status='done', result=$2, finished_at=now() WHERE id=$1", [id, result.slice(0, 20_000)]);
        return { id, status: "done" as const, result };
      } catch (err) {
        await service.db.query("UPDATE computer_requests SET status='failed', result=$2, finished_at=now() WHERE id=$1", [id, (err as Error).message.slice(0, 2000)]);
        throw err;
      }
    });
    this.queues.set(key, run.catch(() => {}));
    return run;
  }

  /** A computer's latest requests: who asked what, and how it went. */
  async requests(service: Service, objectId: string) {
    this.where(service, objectId);
    const { rows } = await service.db.query(
      `SELECT id, requester, app, input, status, left(result, 2000) AS result, created_at, finished_at FROM computer_requests
        WHERE org_id=$1 AND object_id=$2 ORDER BY created_at DESC LIMIT 30`,
      [service.orgId, objectId],
    );
    return rows.map((r) => ({ id: r.id, requester: r.requester, app: r.app, input: r.input, status: r.status, result: r.result, createdAt: r.created_at, finishedAt: r.finished_at }));
  }

  private async perform(service: Service, objectId: string, r: ComputerRequest): Promise<string> {
    if (!("app" in r)) return this.think(service, objectId, r.text);
    const { computer } = this.where(service, objectId);
    switch (r.app) {
      case "browser": {
        const { app: _, ...a } = r;
        return this.act(service, objectId, a as BrowserAction);
      }
      case "mcp":
        return r.action === "tools" ? JSON.stringify(await connectorTools(service, r.connector)) : (await callConnector(service, r.connector, r.tool, r.args)).text;
      case "stream": {
        const c = await this.ready(service, objectId);
        if (r.action === "stop") {
          await this.closeApp(c, "stream");
          return "stopped playing";
        }
        const url = r.url ? toUrl(r.url) : computer.stream;
        if (!url || !/^https?:\/\//i.test(url)) throw badRequest("say what to play: an http(s) link to a video, an HLS stream or a page");
        await this.appTab(c, "stream", this.playable(url, c));
        await this.show(c, "stream");
        return `playing ${url} on the screen`;
      }
      case "camera":
        return this.lookCamera(service, objectId, r.question);
      case "terminal": {
        // On its screen, so people see what runs; the output comes back from its runtime.
        const c = await this.ready(service, objectId);
        if (!c.apps.has("terminal")) await this.appTab(c, "terminal", TERMINAL_URL);
        await this.show(c, "terminal");
        const out = await this.run(c, r.command);
        return `exit ${out.code}${out.timedOut ? " (stopped after 2 minutes)" : ""}\n${out.output}`;
      }
      case "screen": {
        const c = await this.ready(service, objectId);
        if (r.show === "terminal" && !c.apps.has("terminal")) await this.appTab(c, "terminal", TERMINAL_URL);
        if (r.show === "camera") await this.cameraTab(service, objectId);
        if (r.show === "stream" && !c.apps.has("stream")) {
          if (!computer.stream) throw badRequest("nothing is playing: play a link first");
          await this.appTab(c, "stream", this.playable(computer.stream, c));
        }
        await this.show(c, r.show);
        return `the screen shows ${r.show}`;
      }
    }
  }

  /**
   * A video file or HLS stream plays in this server's small player page; anything else opens as it is.
   * A paired machine's browser reaches the page the way its bridge reaches Agentown (it says how).
   */
  private playable(url: string, c: Computer) {
    const said = c.health?.base;
    const at = typeof said === "string" && /^https?:\/\/[^/]+$/.test(said) ? said : this.opts.apiUrl;
    return /\.(mp4|webm|ogg|ogv|m3u8)(\?|#|$)/i.test(url) ? `${at}/api/browser/player?src=${encodeURIComponent(url)}` : url;
  }

  /** The window of an app (its own window, so it keeps painting when not in front), at this page. */
  /** A shell command in the computer's own container (its runtime runs it, shows it in the terminal, sends back the output). */
  private run(c: Computer, command: string) {
    const id = newId("run");
    return new Promise<{ code: number | null; output: string; timedOut: boolean }>((resolve, reject) => {
      const late = setTimeout(() => {
        c.runs.delete(id);
        reject(new ApiError(504, "terminal_timeout", "the computer did not answer"));
      }, 150_000);
      c.runs.set(id, {
        done: (m) => {
          clearTimeout(late);
          resolve({ code: typeof m.code === "number" ? m.code : null, output: typeof m.output === "string" ? m.output : "", timedOut: m.timedOut === true });
        },
        fail: (e) => {
          clearTimeout(late);
          reject(e);
        },
      });
      if (c.bridge?.readyState !== 1) return c.runs.get(id)!.fail(new ApiError(503, "computer_offline", "the computer is offline"));
      c.bridge.send(JSON.stringify({ agentown: "run", id, command }));
    });
  }

  private async appTab(c: Computer, app: "stream" | "camera" | "terminal", url: string): Promise<Page> {
    let page = c.pages.find((p) => p.targetId === c.apps.get(app));
    if (!page) {
      const { targetId } = await this.cdp(c, "Target.createTarget", { url: "about:blank", newWindow: true, background: true });
      c.apps.set(app, targetId);
      // --kiosk covers only the first window: full screen hides this one's tab and address bars too.
      await this.cdp(c, "Browser.getWindowForTarget", { targetId })
        .then(({ windowId }) => windowId && this.cdp(c, "Browser.setWindowBounds", { windowId, bounds: { windowState: "fullscreen" } }))
        .catch(() => {});
      for (let i = 0; i < 30 && !(page = c.pages.find((p) => p.targetId === targetId)); i++) {
        await this.attachPage(c, { targetId, url: "about:blank", title: "" }).catch(() => {});
        if (!c.pages.some((p) => p.targetId === targetId)) await sleep(100);
      }
      if (!page) throw new ApiError(502, "browser_error", `could not open the ${app} window`);
    }
    if (page.url !== url) await this.navigate(c, url, page.sessionId);
    return page;
  }

  private async closeApp(c: Computer, app: "stream" | "camera" | "terminal") {
    const id = c.apps.get(app);
    c.apps.delete(app);
    if (c.showing === app) c.showing = "browser";
    if (id) await this.cdp(c, "Target.closeTarget", { targetId: id }).catch(() => {});
    await this.recast(c);
  }

  /** Switch what the screen shows. A video off the screen pauses (decoding it is most of a computer's CPU). */
  private async show(c: Computer, app: ScreenApp) {
    c.showing = app;
    c.usedAt = Date.now();
    const stream = c.pages.find((p) => p.targetId === c.apps.get("stream"));
    if (stream) {
      const expression = `document.querySelectorAll("video").forEach((v) => ${app === "stream" ? "v.play().catch(() => {})" : "v.pause()"})`;
      await this.cdp(c, "Runtime.evaluate", { expression }, stream.sessionId).catch(() => {});
    }
    await this.recast(c);
  }

  // ------------------------------------------------------------ camera

  private async cameraTab(service: Service, objectId: string) {
    const { computer } = this.where(service, objectId);
    if (!computer.camera) throw badRequest("this computer has no camera feed (computer.camera.url)");
    const c = await this.ready(service, objectId);
    const page = await this.appTab(c, "camera", this.playable(computer.camera.url, c));
    // A still image is a snapshot: fetch a fresh one.
    if (/\.(jpe?g|png|webp)(\?|#|$)|snapshot/i.test(computer.camera.url)) {
      await this.cdp(c, "Page.reload", { ignoreCache: true }, page.sessionId);
      await sleep(1500);
    }
    return { c, page, camera: computer.camera };
  }

  private async shot(c: Computer, page: Page, scale: number): Promise<string> {
    const r = await this.cdp(c, "Page.captureScreenshot", { format: "jpeg", quality: 60, clip: { x: 0, y: 0, width: 1280, height: 800, scale } }, page.sessionId);
    return r.data;
  }

  /** How different two small frames are (mean per channel, 0–255), worked out by the computer's own Chromium. */
  private async change(c: Computer, page: Page, a: string, b: string): Promise<number> {
    const { result } = await this.cdp(c, "Runtime.evaluate", {
      awaitPromise: true,
      returnByValue: true,
      expression: `(async () => {
        const px = async (d) => { const i = new Image(); i.src = "data:image/jpeg;base64," + d; await i.decode();
          const v = new OffscreenCanvas(32, 20).getContext("2d"); v.drawImage(i, 0, 0, 32, 20); return v.getImageData(0, 0, 32, 20).data; };
        const [p, q] = await Promise.all([px(${JSON.stringify(a)}), px(${JSON.stringify(b)})]);
        let s = 0; for (let k = 0; k < p.length; k += 4) s += Math.abs(p[k] - q[k]) + Math.abs(p[k + 1] - q[k + 1]) + Math.abs(p[k + 2] - q[k + 2]);
        return s / (32 * 20 * 3);
      })()`,
    }, page.sessionId);
    return Number(result?.value ?? 0);
  }

  private async lookCamera(service: Service, objectId: string, question?: string) {
    const { c, page } = await this.cameraTab(service, objectId);
    c.usedAt = Date.now();
    return this.see(service, await this.shot(c, page, 0.5), question || "Describe briefly what the camera shows right now.");
  }

  /**
   * Computers with a camera watch it while their organization runs: every so often a small frame;
   * when it changed, the model looks and reports what it was told to watch for (a request on the
   * computer, and a task for the agent to notify), then stays quiet for a while.
   */
  private async watchCameras() {
    if (this.watching || !this.driver) return;
    this.watching = true;
    try {
      for (const orgId of await this.instance.activeOrgIds()) {
        const service = await this.instance.org(orgId).catch(() => null);
        if (!service || service.runState !== "running") continue;
        for (const o of this.entries(service)) {
          const computer = o.computer;
          if (!computer.camera || !computer.apps.includes("camera")) continue;
          const c = this.get(orgId, o.id);
          if (Date.now() - c.lookedAt < computer.camera.everySeconds * 1000) continue;
          c.lookedAt = Date.now();
          await this.watchOne(service, o.id, o.name).catch((err) => this.opts.log?.("camera watch failed", { orgId, objectId: o.id, err: String(err).slice(0, 300) }));
        }
      }
    } finally {
      this.watching = false;
    }
  }

  private async watchOne(service: Service, objectId: string, name: string) {
    const { c, page, camera } = await this.cameraTab(service, objectId);
    c.usedAt = Date.now(); // a watching camera keeps its computer on
    const frame = await this.shot(c, page, 0.05);
    const before = c.frame;
    c.frame = frame;
    if (!before || Date.now() < c.quietUntil || (await this.change(c, page, before, frame)) < CHANGE) return;
    const answer = await this.see(service, await this.shot(c, page, 0.5),
      `This is the camera of "${name}". The picture just changed. Watch for: ${camera.watchFor ?? "people arriving or anything unusual"}. ` +
      `If what you see is that, answer "REPORT: " and one sentence on what you see; otherwise answer "IGNORE".`);
    const report = /^\s*REPORT:\s*(.+)/is.exec(answer)?.[1]?.trim();
    if (!report) return;
    c.quietUntil = Date.now() + REPORT_QUIET_MS;
    await service.db.query(
      "INSERT INTO computer_requests(id, org_id, object_id, requester, app, input, status, result, started_at, finished_at) VALUES ($1,$2,$3,$4,'camera',$5,'done',$6,now(),now())",
      [newId("cr"), service.orgId, objectId, `computer:${objectId}`, JSON.stringify({ event: "change" }), report.slice(0, 2000)],
    );
    if (camera.notify) {
      await service.createTask(await service.ownerActor(), {
        title: `${name}: ${cut(report, 80)}`,
        description: `The camera of ${name} saw: ${report}\n\nIt was told to watch for: ${camera.watchFor ?? "people arriving or anything unusual"}. Look with \`agentown computer ${objectId} camera\` if you need more, then act on it.`,
        assigneeAgentId: camera.notify,
        requiresReview: false,
        spec: { kind: "prompt" },
      });
    }
  }

  // ------------------------------------------------------------ the computer's model

  /** The model a computer thinks with: the organization's top agent's, like objects people chat with. */
  private async brain(service: Service) {
    const owner = await service.ownerActor();
    const credentials = (await service.listCredentials(owner)).filter((x) => !x.revokedAt);
    const root = (await service.listAgents(owner)).find((a) => !a.reportsToAgentId && a.lifecycleState !== "retired");
    const config = root ? (await service.getAgent(owner, root.id)).config : null;
    const credential = credentials.find((x) => x.id === config?.credentialId) ?? credentials[0];
    if (!credential?.models.length) throw new ApiError(409, "no_model", "the computer needs a model to understand requests in words: add an API key first");
    const model = config?.model && credential.models.includes(config.model) ? config.model : credential.models[0]!;
    const llm = this.factory(await service.ownerChatCredential(owner, credential.id));
    return { llm, config: chatConfigSchema.parse({ credentialId: credential.id, model, effort: "low", maxOutputTokens: 2048, maxTurns: 8 }) };
  }

  private async see(service: Service, image: string, question: string) {
    const { llm, config } = await this.brain(service);
    const signal = AbortSignal.timeout(90_000);
    const { message } = await llm.complete({
      system: "You look at a camera picture and answer briefly and factually, in the language of the question.",
      messages: [{ role: "user", text: question, images: [image] }], tools: [], config, info: await llm.info(config.model, signal), signal,
    });
    return message.text.trim() || "(nothing to say)";
  }

  /** A request in words: the computer's model does it with its apps as tools. */
  private async think(service: Service, objectId: string, text: string): Promise<string> {
    const { object, kind, computer } = this.where(service, objectId);
    const { llm, config } = await this.brain(service);
    const signal = AbortSignal.timeout(170_000);
    const tools = this.tools(service, objectId, computer.apps);
    const system = [
      `You are the computer "${object.label ?? kind.name}" of ${service.config.organization.name}. People and agents send you requests; you do each one with your apps and reply with a short, factual result in the requester's language.`,
      `Your apps: ${computer.apps.join(", ")}.${computer.apps.includes("mcp") ? ` Connectors attached to you: ${computer.connectors.join(", ") || "none"}.` : ""}`,
      "Do only what was asked. Never invent results: if an app fails, say so. Never ask for passwords.",
    ].join("\n");
    const messages: Message[] = [{ role: "user", text }];
    const info = await llm.info(config.model, signal);
    for (let turn = 0; turn < config.maxTurns; turn++) {
      const { message } = await llm.complete({ system, messages, tools, config, info, signal });
      messages.push(message);
      if (!message.calls?.length) return message.text.trim() || "(done)";
      for (const call of message.calls) {
        const tool = tools.find((t) => t.name === call.name);
        let out: string;
        let isError = false;
        try {
          if (!tool) throw new Error(`unknown tool ${call.name}`);
          out = String(await tool.execute(undefined as never, tool.schema.parse(call.args)));
        } catch (err) {
          out = (err as Error).message;
          isError = true;
        }
        messages.push({ role: "tool", toolId: call.id, text: cut(out, 20_000), isError });
      }
    }
    return `Stopped after ${config.maxTurns} steps. Last result: ${cut(messages.at(-1)?.text ?? "", 500)}`;
  }

  /** The computer's apps as tools for its model (each one an exact request). */
  private tools(service: Service, objectId: string, apps: string[]): ChatTool[] {
    const run = (r: ComputerRequest) => this.perform(service, objectId, r);
    const tools: ChatTool[] = [
      { name: "show", description: "Switch what your screen shows: browser, stream, camera or terminal.", schema: z.object({ app: z.enum(SCREEN_APPS) }).strict(), execute: (_, a) => run({ app: "screen", show: a.app }) },
    ];
    if (apps.includes("browser")) tools.push({
      name: "browser",
      description: "Use your browser. One action per call; returns the page as text with refs (e5) for click/type. Actions: look, open (url), click (ref), type (text, ref?, submit?), key (key), scroll (dy), back, tab (index).",
      schema: z.object({ action: z.enum(["look", "open", "click", "type", "key", "scroll", "back", "tab"]), url: z.string().max(2000).optional(), ref: z.string().optional(), text: z.string().max(10_000).optional(), submit: z.boolean().optional(), key: z.string().optional(), dy: z.number().optional(), index: z.number().int().optional() }).strict(),
      execute: (_, a) => run({ app: "browser", ...a }),
    });
    if (apps.includes("mcp")) tools.push(
      { name: "mcp_tools", description: "List one attached connector's tools with their input schemas.", schema: z.object({ connector: z.string() }).strict(), execute: (_, a) => run({ app: "mcp", action: "tools", connector: a.connector }) },
      { name: "mcp_call", description: "Call one tool of an attached connector.", schema: z.object({ connector: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()).default({}) }).strict(), execute: (_, a) => run({ app: "mcp", action: "call", ...a }) },
    );
    if (apps.includes("stream")) tools.push(
      { name: "stream_play", description: "Play a video (a file, HLS .m3u8, or a page such as YouTube) on your screen; without url, the default one.", schema: z.object({ url: z.string().max(1000).optional() }).strict(), execute: (_, a) => run({ app: "stream", action: "play", url: a.url }) },
      { name: "stream_stop", description: "Stop playing.", schema: z.object({}).strict(), execute: () => run({ app: "stream", action: "stop" }) },
    );
    if (apps.includes("terminal")) tools.push({
      name: "terminal_run",
      description: "Run a shell command (sh) in your own Linux container, as an unprivileged user; your files are in /workspace. It shows in your terminal. Returns the exit code and output (up to 20000 characters; stopped after 2 minutes).",
      schema: z.object({ command: z.string().min(1).max(4000) }).strict(),
      execute: (_, a) => run({ app: "terminal", action: "run", command: a.command }),
    });
    if (apps.includes("camera")) tools.push({ name: "camera_look", description: "Look through your camera and say what it shows (ask something specific if you want).", schema: z.object({ question: z.string().max(1000).optional() }).strict(), execute: (_, a) => run({ app: "camera", action: "look", question: a.question }) });
    return tools;
  }

  // ------------------------------------------------------------ its own network (proxy or VPN)

  /** Set (or clear) a computer's network secret: the proxy address, or the WireGuard config. The owner's alone. */
  async setNetwork(service: Service, actor: Actor, objectId: string, secret: string | null) {
    if (!(actor.kind === "human" && actor.owner)) throw deny("only the owner sets a computer's proxy or VPN");
    const { computer } = this.where(service, objectId);
    if (secret === null) await service.db.query("DELETE FROM computer_secrets WHERE org_id=$1 AND object_id=$2", [service.orgId, objectId]);
    else {
      if (computer.network === "proxy" && !/^(https?|socks5h?):\/\/[^\s]+$/i.test(secret.trim())) throw badRequest("a proxy is an address like http://user:pass@host:port or socks5://host:port");
      if (computer.network === "vpn" && !/\[Interface\][\s\S]*PrivateKey[\s\S]*\[Peer\]/i.test(secret)) throw badRequest("a VPN here is a WireGuard config (with [Interface], PrivateKey and [Peer])");
      await service.db.query(
        `INSERT INTO computer_secrets(org_id, object_id, ciphertext) VALUES ($1,$2,$3)
         ON CONFLICT (org_id, object_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, updated_at=now()`,
        [service.orgId, objectId, service.secrets.seal(secret.trim())],
      );
    }
    await service.kernel.permissions.audit(service.db, actor, secret === null ? "computer.network_cleared" : "computer.network_set", objectId, true, computer.network ?? "direct");
    await this.restart(service, objectId);
    return this.status(service, objectId);
  }

  /** What a computer's runtime connects through (asked by the runtime itself; a paired machine browses directly). */
  async networkFor(orgId: string, objectId: string) {
    const service = await this.instance.org(orgId);
    const { computer } = this.where(service, objectId);
    const mode = computer.remote ? "direct" : computer.network ?? "direct";
    if (mode === "direct") return { mode };
    const row = (await service.db.query<{ ciphertext: Buffer }>("SELECT ciphertext FROM computer_secrets WHERE org_id=$1 AND object_id=$2", [orgId, objectId])).rows[0];
    if (!row) return { mode };
    const secret = service.secrets.open(row.ciphertext);
    return mode === "proxy" ? { mode, proxy: secret } : { mode, wireguard: secret };
  }

  /** Start its runtime again (a new network takes effect on start). */
  async restart(service: Service, objectId: string) {
    const w = this.where(service, objectId);
    const c = this.all.get(`${service.orgId}/${objectId}`);
    c?.bridge?.close(4000, "restarting");
    if (this.driver && !w.computer.remote) for (const p of (await this.driver.listPods(w.namespace, w.runtimeId)).filter((x) => !x.terminating)) await this.driver.deletePod(w.namespace, p.name);
  }

  // ------------------------------------------------------------ a paired machine (remote)

  /**
   * A one-time pairing: the machine that will run this computer runs one command (with sudo),
   * which fetches a script from the link below; the script claims the link once, gets this
   * computer's own token (good for nothing but being this computer), and starts the computer
   * in Docker there, connecting out to Agentown. Nothing on that machine accepts connections.
   */
  async pair(service: Service, actor: Actor, objectId: string) {
    if (!(await this.mayWatch(service, actor))) throw deny("only the owner, or people who may design the world, pair computers");
    const { computer } = this.where(service, objectId);
    if (!computer.remote) throw conflict("not_remote", "turn on Remote connect in this computer's config first (and save)");
    const routes = this.routes();
    if (!routes.length) throw conflict("no_route", "this server has no direct port for paired machines (AGENTOWN_REMOTE_PORT, and openssl to make its key)");
    const token = `apr_${newSecret()}`;
    const hash = sha256(token);
    const expires = new Date(Date.now() + PAIR_MS);
    const old = await service.db.query<{ hash: string }>("DELETE FROM computer_pairings WHERE org_id=$1 AND object_id=$2 AND claimed_at IS NULL RETURNING hash", [service.orgId, objectId]);
    for (const r of old.rows) this.unwait(r.hash);
    await service.db.query("INSERT INTO computer_pairings(hash, org_id, object_id, expires_at) VALUES ($1,$2,$3,$4)", [hash, service.orgId, objectId, expires]);
    // The link on a temporary address that closes once it is used; else on this server's direct
    // port (its key pinned in the command). Never through the address people open Agentown at.
    const temporary = (await this.tunnel?.open(hash, PAIR_MS)) ?? null;
    const direct = routes.find((x) => x.kind === "public") ?? routes.find((x) => x.kind === "tailscale") ?? routes[0]!;
    await service.kernel.permissions.audit(service.db, actor, "computer.pair", objectId, true, temporary ? "pairing link made (temporary address)" : "pairing link made");
    const url = `${temporary ?? `https://${direct.address}`}/pair/${token}`;
    const command = temporary ? `curl -fsSL '${url}' | sudo bash` : `curl -fsSLk --pinnedpubkey 'sha256//${this.opts.remote!.pin}' '${url}' | sudo bash`;
    return { url, command, expiresAt: expires.toISOString(), temporary: !!temporary, routes };
  }

  /** Where a paired machine may reach this server: directly (its own port, TLS with its key pinned), best first. */
  private routes() {
    const r = this.opts.remote;
    if (!r) return [];
    const order = { lan: 0, tailscale: 1, public: 2, domain: 3 };
    return routesOf(r.port, r.publicHost).sort((a, b) => order[a.kind] - order[b.kind]);
  }

  private async pairing(token: string) {
    const { rows } = await this.instance.db.query<{ org_id: string; object_id: string }>(
      "SELECT org_id, object_id FROM computer_pairings WHERE hash=$1 AND claimed_at IS NULL AND expires_at > now()",
      [sha256(token)],
    );
    if (!rows[0]) throw notFound("pairing link (it is used once and expires after 15 minutes: make a new one)");
    return rows[0];
  }

  /** The script the pairing command runs on the other machine. */
  async pairScript(token: string, origin: string) {
    const { org_id, object_id } = await this.pairing(token);
    const service = await this.instance.org(org_id);
    const { object, kind } = this.where(service, object_id);
    return pairScript({ origin, token, name: object.label ?? kind.name, container: `agentown-${org_id}-${object_id}`, routes: this.routes().map((x) => x.address), pin: this.opts.remote?.pin ?? "" });
  }

  private unwait(hash: string) {
    this.tunnel?.done(hash);
  }

  /** A pairing link (on the temporary address or this server's direct port; never on Agentown's own address). */
  async servePair(req: http.IncomingMessage, res: http.ServerResponse, origin: string) {
    const m = /^\/pair\/(apr_[\w-]{20,100})(\/claim)?$/.exec((req.url ?? "").split("?")[0]!);
    try {
      if (m && !m[2] && req.method === "GET") {
        const script = await this.pairScript(m[1]!, origin);
        return res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-store" }).end(script);
      }
      if (m && m[2] && req.method === "POST") {
        let body = "";
        for await (const chunk of req) if ((body += chunk).length > 8192) throw badRequest("too large");
        let machine = {};
        try {
          machine = JSON.parse(body || "{}");
        } catch {}
        const answer = JSON.stringify(await this.claim(m[1]!, machine));
        return res.writeHead(200, { "content-type": "application/json" }).end(answer);
      }
      res.writeHead(404).end();
    } catch (err) {
      res.writeHead(err instanceof ApiError ? err.status : 500, { "content-type": "application/json" }).end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  /** The other machine claims the link (once): this computer's token and the image to run. */
  async claim(token: string, machine: { host?: string; os?: string; arch?: string; cpus?: number; memoryMb?: number }) {
    const { org_id, object_id } = await this.pairing(token);
    const hash = sha256(token);
    const claimed = await this.instance.db.query("UPDATE computer_pairings SET claimed_at=now() WHERE hash=$1 AND claimed_at IS NULL RETURNING 1", [hash]);
    if (!claimed.rows[0]) throw notFound("pairing link");
    // Its temporary address closes once this answer has gone back through it.
    setTimeout(() => this.tunnel?.done(hash), 5000).unref();
    const service = await this.instance.org(org_id);
    const w = this.where(service, object_id);
    // The new token replaces any other (a pod here, an older machine): they disconnect.
    const computerToken = await service.kernel.identity.issueComputerToken(object_id);
    if (this.driver) await this.driver.teardown(w.namespace, w.runtimeId, false).catch(() => {});
    const was = this.all.get(`${org_id}/${object_id}`);
    was?.bridge?.close(4000, "paired elsewhere");
    if (was) was.health = null; // that was the old runtime's
    const cut = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : null);
    await service.db.query(
      `INSERT INTO computer_machines(org_id, object_id, host, os, arch, cpus, memory_mb) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (org_id, object_id) DO UPDATE SET host=EXCLUDED.host, os=EXCLUDED.os, arch=EXCLUDED.arch, cpus=EXCLUDED.cpus, memory_mb=EXCLUDED.memory_mb, paired_at=now(), last_seen_at=NULL`,
      [org_id, object_id, cut(machine.host, 120), cut(machine.os, 120), cut(machine.arch, 40), Number.isFinite(machine.cpus) ? Math.round(machine.cpus!) : null, Number.isFinite(machine.memoryMb) ? Math.round(machine.memoryMb!) : null],
    );
    const image = service.config.runtimeCatalog.find((p) => p.harness === "browser")?.image ?? "agentown/browser";
    return { token: computerToken, image };
  }

  /** Forget the paired machine: its token stops working and it disconnects. */
  async unpair(service: Service, actor: Actor, objectId: string) {
    if (!(await this.mayWatch(service, actor))) throw deny("only the owner, or people who may design the world, pair computers");
    this.where(service, objectId);
    await service.db.query("UPDATE tokens SET revoked_at=now() WHERE principal_kind='computer' AND principal_id=$1 AND revoked_at IS NULL", [`${service.orgId}/${objectId}`]);
    await service.db.query("DELETE FROM computer_machines WHERE org_id=$1 AND object_id=$2", [service.orgId, objectId]);
    await service.kernel.permissions.audit(service.db, actor, "computer.unpair", objectId, true, "paired machine forgotten");
    const was = this.all.get(`${service.orgId}/${objectId}`);
    was?.bridge?.close(4401, "unpaired");
    if (was) was.health = null;
    return this.status(service, objectId);
  }
}

/** Bash, run with sudo on the machine that will run the computer (Linux or macOS with Docker). */
function pairScript(a: { origin: string; token: string; name: string; container: string; routes: string[]; pin: string }) {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  return `#!/usr/bin/env bash
# Agentown: run the computer ${JSON.stringify(a.name)} on this machine. It runs in Docker (its own
# container, profile and network) and connects out to Agentown directly: TLS to Agentown's own port,
# its key pinned (nobody on the way can read or change anything). Nothing here accepts connections.
set -euo pipefail
URL=${q(a.origin)}
PAIR=${q(a.token)}
NAME=${q(a.container)}
PIN=${q(a.pin)}
ROUTES=${q(a.routes.join(","))}
[ "$(id -u)" = 0 ] || { echo "Run it with sudo." >&2; exit 1; }
# First: can this machine reach Agentown directly at all? (Before anything is set up or the link is used.)
DIRECT=""
for R in $(printf '%s' "$ROUTES" | tr ',' ' '); do
  if curl -fsSk --pinnedpubkey "sha256//$PIN" --max-time 5 -o /dev/null "https://$R/api/browser/hello" 2>/dev/null; then DIRECT="$R"; break; fi
done
if [ -z "$DIRECT" ]; then
  echo "This machine cannot reach Agentown directly (tried: $ROUTES)." >&2
  echo "Nothing was set up, and the pairing link is still unused. To connect it, either:" >&2
  echo "  - put both machines on the same network," >&2
  echo "  - install Tailscale on both (then make a new link in Agentown: it offers the Tailscale address), or" >&2
  echo "  - open port \${ROUTES##*:} to Agentown (firewall or router) at one of the addresses above." >&2
  exit 1
fi
echo "Agentown answers directly at $DIRECT (encrypted end to end)."
# sudo may leave out where Docker Desktop, OrbStack or Homebrew put it.
PATH="$PATH:/usr/local/bin:/opt/homebrew/bin"
if ! command -v docker >/dev/null 2>&1; then
  # Not installed for you: a script piped from the internet would run as root here, and nothing could pin it.
  echo "Docker is not installed. Install it first, then run this again:" >&2
  echo "  Linux: your distribution's docker package, or https://docs.docker.com/engine/install/" >&2
  echo "  macOS/Windows: Docker Desktop or OrbStack" >&2
  exit 1
fi
command -v systemctl >/dev/null 2>&1 && systemctl enable --now docker >/dev/null 2>&1 || true
CPUS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0)
MEM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo 2>/dev/null || echo $(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1048576 )))
INFO=$(printf '{"host":"%s","os":"%s","arch":"%s","cpus":%s,"memoryMb":%s}' "$(hostname)" "$(uname -sr)" "$(uname -m)" "$CPUS" "$MEM")
REPLY=$(curl -fsS -X POST -H 'content-type: application/json' --data "$INFO" "$URL/pair/$PAIR/claim") || { echo "The pairing link did not answer (used, expired or unreachable): make a new one in Agentown." >&2; exit 1; }
TOKEN=$(printf '%s' "$REPLY" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')
IMAGE=$(printf '%s' "$REPLY" | sed -n 's/.*"image":"\\([^"]*\\)".*/\\1/p')
[ -n "$TOKEN" ] && [ -n "$IMAGE" ] || { echo "Agentown did not answer as expected." >&2; exit 1; }
# Kept for later: the container restarts with it by itself; pairing again replaces it.
install -d -m 0700 /etc/agentown-computer
printf '%s' "$TOKEN" > "/etc/agentown-computer/$NAME.token"; chmod 0600 "/etc/agentown-computer/$NAME.token"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "Downloading the computer image..."
  curl -fsSLk --pinnedpubkey "sha256//$PIN" -H "authorization: Bearer $TOKEN" "https://$DIRECT/api/browser/image" | gunzip | docker load >/dev/null || { echo "Could not download the computer image from Agentown." >&2; exit 1; }
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --restart unless-stopped --platform linux/amd64 \\
  --read-only --tmpfs /tmp --shm-size 1g --cap-drop ALL --security-opt no-new-privileges \\
  -e HOME=/workspace/home -e AGENTOWN_API_URL="https://$DIRECT" -e AGENTOWN_ROUTES="$ROUTES" -e AGENTOWN_PIN="$PIN" -e AGENTOWN_TOKEN="$TOKEN" -v "$NAME:/workspace" "$IMAGE" >/dev/null
echo "Done: this machine now runs ${a.name.replace(/[^\w .-]/g, "")} for Agentown (container $NAME). Its health shows on the computer in Agentown."
`;
}
