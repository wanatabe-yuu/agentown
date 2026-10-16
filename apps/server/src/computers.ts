import type { Actor } from "@agentown/core";
import type { Instance } from "./instance.ts";
import { classify } from "./runtime/controller.ts";
import type { RuntimeDriver, RuntimeSpec } from "./runtime/driver.ts";
import { namespaceFor, type Service } from "./service.ts";
import { ApiError, badRequest, deny, notFound, sha256 } from "./util.ts";

/**
 * The world's computers. Each placed object whose kind has `browser` is one
 * Chromium with a screen, run as a pod from the catalog's browser image. The pod
 * dials out to /api/browser/bridge and carries the DevTools protocol over that
 * one socket; through it agents drive the page (open, look, click, type) and
 * people watch the screen and take over, e.g. to log in. A computer starts when
 * first used and stops after IDLE_MS with nobody using or watching it; its
 * profile (logins, cookies) lives on the pod's volume and survives restarts.
 */

/** The part of a WebSocket (ws) this module uses. */
export interface Sock {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", fn: (data: Buffer) => void): void;
  on(event: "close", fn: () => void): void;
  readyState: number;
}

const IDLE_MS = 15 * 60_000;
const BOOT_MS = 120_000;
const UNSCHEDULABLE_MS = 45_000;
const CALL_MS = 30_000;
const SNAPSHOT_CHARS = 15_000;

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
  /** The CDP session whose screen streams to viewers. */
  casting: string | null = null;
  loads = new Map<string, Array<() => void>>();
  /** Since when its pod has found no machine with room. */
  unschedulable: number | null = null;
  constructor(
    readonly orgId: string,
    readonly objectId: string,
  ) {}
  get page() {
    return this.pages.at(-1) ?? null;
  }
}

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

  constructor(
    private readonly instance: Instance,
    private readonly driver: RuntimeDriver | null,
    private readonly opts: { apiUrl: string; log?: (msg: string, extra?: Record<string, unknown>) => void },
  ) {}

  start() {
    this.timer = setInterval(() => void this.reconcile(), 5000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const c of this.all.values()) c.bridge?.close();
  }

  private get(orgId: string, objectId: string) {
    const key = `${orgId}/${objectId}`;
    let c = this.all.get(key);
    if (!c) this.all.set(key, (c = new Computer(orgId, objectId)));
    return c;
  }

  /** The computer object, its kind and where its pod runs. */
  where(service: Service, objectId: string) {
    const world = service.config.world;
    const object = world?.objects.find((x) => x.id === objectId);
    const kind = object && world!.kinds[object.kind];
    if (!object || !kind?.browser) throw notFound("computer");
    const room = world!.floors.flatMap((f) => f.rooms).find((r) => r.id === object.room);
    const department = room?.department ?? service.config.departments[0]!.id;
    return {
      object,
      kind,
      preset: service.config.runtimeCatalog.find((p) => p.harness === "browser") ?? null,
      runtimeId: `pc-${objectId}-${sha256(service.orgId).slice(0, 6)}`,
      namespace: service.runtimeNamespace ?? namespaceFor(department),
    };
  }

  /** The world's computers with what each is doing, for the office and agents. */
  list(service: Service) {
    const world = service.config.world;
    return (world?.objects ?? [])
      .filter((o) => o.id && world!.kinds[o.kind]?.browser)
      .map((o) => {
        const c = this.all.get(`${service.orgId}/${o.id}`);
        return { id: o.id!, name: o.label ?? world!.kinds[o.kind]!.name, room: o.room, state: c?.state ?? "off", detail: c?.detail ?? null, url: c?.page?.url ?? null, title: c?.page?.title ?? null, watching: c?.viewers.size ?? 0 };
      });
  }

  status(service: Service, objectId: string) {
    this.where(service, objectId);
    return this.list(service).find((c) => c.id === objectId)!;
  }

  /** Want the computer on; resolves once its browser is connected. */
  async ready(service: Service, objectId: string): Promise<Computer> {
    const w = this.where(service, objectId);
    if (!w.preset) throw new ApiError(503, "no_browser_image", "this install has no browser image: add a runtimeCatalog preset with harness: browser");
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
    } catch {
      c.wanted = false; // the object (or its organization) is gone
      c.bridge?.close();
      c.state = "off";
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
        teamId: `computer-${c.objectId}`,
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
    sock.on("message", (d) => this.onMessage(c, d));
    sock.on("close", () => {
      if (c.bridge !== sock) return;
      c.bridge = null;
      c.pages = [];
      c.casting = null;
      for (const [, call] of c.calls) call.fail(new ApiError(503, "computer_offline", "the computer went offline"));
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
    return this.where(service, objectId).kind.browser?.home ?? null;
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
        const before = c.page?.targetId;
        c.pages = c.pages.filter((x) => x.targetId !== p.targetId);
        if (before !== c.page?.targetId) void this.recast(c).catch(() => {});
        break;
      }
      case "Target.targetInfoChanged": {
        const page = c.pages.find((x) => x.targetId === p.targetInfo?.targetId);
        if (page) {
          page.url = p.targetInfo.url;
          page.title = p.targetInfo.title;
          if (page === c.page) this.broadcastPage(c);
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
      case "Page.screencastFrame":
        void this.cdp(c, "Page.screencastFrameAck", { sessionId: p.sessionId }, m.sessionId).catch(() => {});
        if (m.sessionId === c.casting) this.broadcast(c, { t: "frame", data: p.data, w: p.metadata?.deviceWidth, h: p.metadata?.deviceHeight });
        break;
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

  private async closeCrashed(c: Computer, page: Page) {
    c.pages = c.pages.filter((x) => x !== page);
    await this.cdp(c, "Target.closeTarget", { targetId: page.targetId }).catch(() => {});
    if (!c.pages.length) await this.cdp(c, "Target.createTarget", { url: "about:blank" });
    await this.recast(c);
  }

  /** Stream the front page to whoever watches (and nothing when nobody does). */
  private async recast(c: Computer) {
    const want = c.viewers.size && c.page ? c.page.sessionId : null;
    if (want === c.casting) return this.broadcastPage(c);
    const old = c.casting;
    c.casting = want;
    if (old) await this.cdp(c, "Page.stopScreencast", {}, old).catch(() => {});
    if (want) {
      await this.cdp(c, "Page.bringToFront", {}, want).catch(() => {});
      await this.cdp(c, "Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1280, maxHeight: 800 }, want).catch(() => {});
    }
    this.broadcastPage(c);
  }

  private broadcast(c: Computer, msg: unknown) {
    const s = JSON.stringify(msg);
    for (const v of c.viewers) if (v.readyState === 1) v.send(s);
  }

  private broadcastPage(c: Computer) {
    this.broadcast(c, { t: "page", url: c.page?.url ?? "", title: c.page?.title ?? "", tabs: c.pages.length });
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
        const page = c.pages[a.index];
        if (!page) throw badRequest(`there is no tab ${a.index} (tabs: 0–${c.pages.length - 1})`);
        c.pages = [...c.pages.filter((x) => x !== page), page];
        await this.cdp(c, "Page.bringToFront", {}, page.sessionId);
        await this.recast(c);
        break;
      }
    }
    c.usedAt = Date.now();
    return this.snapshot(c);
  }

  private async navigate(c: Computer, url: string) {
    const s = c.page!.sessionId;
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
    const tabs = c.pages.length > 1 ? `Tabs: ${c.pages.map((p, i) => `${i}${p === page ? "*" : ""} ${cut(p.title || p.url, 40)}`).join(" | ")}\n` : "";
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
      c.usedAt = Date.now();
      void this.recast(c).catch(() => {});
    });
    sock.on("message", (d) => void this.input(c, d).catch(() => {}));
    sock.send(JSON.stringify({ t: "status", state: c.state, detail: c.detail }));
    try {
      await this.ready(service, objectId);
      await this.recast(c);
    } catch (err) {
      sock.send(JSON.stringify({ t: "status", state: "error", detail: (err as Error).message }));
    }
  }

  private async input(c: Computer, raw: Buffer) {
    const m = JSON.parse(raw.toString("utf8"));
    const s = c.page?.sessionId;
    if (!s || c.state !== "on") return;
    c.usedAt = Date.now();
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
        if (typeof m.url === "string") return this.navigate(c, toUrl(m.url));
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
}
