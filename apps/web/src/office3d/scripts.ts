import * as THREE from "three";

/**
 * Object scripts from the world (a kind's `script`), run where they cannot
 * hurt anyone: an iframe sandboxed to an opaque origin (no cookies, no API, no
 * parent page) whose CSP forbids every network request, running the code in a
 * Worker so a runaway loop cannot freeze the office. A script only answers each
 * tick with poses for parts; a script that stops answering is switched off.
 *
 *   api.onTick((obj, t) => {
 *     obj.set("blade", { rotation: [0, t * 90, 0] });          // a named part
 *     obj.set("", { position: [0, Math.sin(t) * 0.1, 0] });     // the whole object
 *     obj.memory.count = (obj.memory.count ?? 0) + 1;           // kept between ticks
 *   });
 *
 * Poses are offsets from where the part rests: position (m), rotation (deg),
 * scale (×), plus color ("#rrggbb") and visible.
 */

const WORKER = `
const kinds = {};
const memory = {};
const failed = new Set();
const fail = (kind, err) => { if (!failed.has(kind)) { failed.add(kind); postMessage({ type: "error", kind, message: String(err && err.message || err).slice(0, 300) }); } };
onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") {
    for (const k of m.kinds) {
      const handlers = {};
      try { new Function("api", '"use strict";\\n' + k.source)({ onTick: (f) => { handlers.tick = f; } }); kinds[k.id] = handlers; }
      catch (err) { fail(k.id, err); }
    }
  } else if (m.type === "tick") {
    const poses = [];
    for (const o of m.objects) {
      const h = kinds[o.kind];
      if (!h || !h.tick || failed.has(o.kind)) continue;
      const obj = { id: o.id, memory: (memory[o.id] ||= {}), set: (part, pose) => { if (poses.length < 2000) poses.push({ id: o.id, part: String(part || ""), pose }); } };
      try { h.tick(obj, m.t); } catch (err) { fail(o.kind, err); }
    }
    postMessage({ type: "poses", seq: m.seq, poses });
  }
};`;

const PAGE = `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:"><script>
const w = new Worker(URL.createObjectURL(new Blob([${JSON.stringify(WORKER)}], { type: "text/javascript" })));
w.onmessage = (e) => parent.postMessage(e.data, "*");
onmessage = (e) => { if (e.source === parent) w.postMessage(e.data); };
parent.postMessage({ type: "ready" }, "*");
</script>`;

interface Pose {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
  color?: string;
  visible?: boolean;
}

const TICK_MS = 66; // ~15 times a second: smooth enough, cheap enough
const HANG_MS = 1500;
const DEG = Math.PI / 180;
const finite = (n: unknown, lim: number) => (typeof n === "number" && Number.isFinite(n) ? Math.max(-lim, Math.min(lim, n)) : 0);
const vec = (v: unknown, lim: number): [number, number, number] | undefined =>
  Array.isArray(v) ? [finite(v[0], lim), finite(v[1], lim), finite(v[2], lim)] : undefined;

export class ScriptHost {
  private frame: HTMLIFrameElement | null;
  private seq = 0;
  private ready = false;
  private waitingSince = 0;
  private lastTick = -Infinity;
  private latest: Array<{ id: string; part: string; pose: Pose }> = [];
  private owned: THREE.Material[] = [];
  private readonly kinds: Array<{ id: string; source: string }>;
  private readonly onMessage = (e: MessageEvent) => {
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    const m = e.data as { type: string; seq?: number; poses?: unknown; kind?: string; message?: string };
    if (m.type === "ready") {
      this.ready = true;
      this.frame.contentWindow?.postMessage({ type: "init", kinds: this.kinds }, "*");
    } else if (m.type === "poses" && m.seq === this.seq && Array.isArray(m.poses)) {
      this.latest = m.poses as typeof this.latest;
      this.waitingSince = 0;
    } else if (m.type === "error") console.warn(`object script for "${m.kind}" stopped: ${m.message}`);
  };

  constructor(scripts: Record<string, string>) {
    this.frame = document.createElement("iframe");
    // allow-scripts without allow-same-origin: an opaque origin with no access to this page or its cookies.
    this.frame.setAttribute("sandbox", "allow-scripts");
    this.frame.setAttribute("aria-hidden", "true");
    this.frame.tabIndex = -1;
    this.frame.style.display = "none";
    this.frame.srcdoc = PAGE;
    this.kinds = Object.entries(scripts).map(([id, source]) => ({ id, source }));
    window.addEventListener("message", this.onMessage);
    document.body.appendChild(this.frame);
  }

  /** Ask for the next poses (throttled); switches scripts off if they stopped answering. */
  tick(now: number, sec: number, objects: Array<{ id: string; kind: string }>) {
    if (!this.frame || !this.ready) return;
    if (this.waitingSince && now - this.waitingSince > HANG_MS) {
      console.warn("object scripts stopped answering and were switched off");
      this.dispose();
      return;
    }
    if (this.waitingSince || now - this.lastTick < TICK_MS) return;
    this.lastTick = now;
    this.waitingSince = now;
    this.frame.contentWindow?.postMessage({ type: "tick", seq: ++this.seq, t: sec, objects }, "*");
  }

  /** Put the latest poses on the objects (every frame, after behaviors). */
  apply(objectOf: (id: string) => THREE.Object3D | undefined) {
    for (const { id, part, pose } of this.latest) {
      const obj = objectOf(id);
      const target = obj && (part ? obj.getObjectByName(part) : obj);
      if (!target || !pose || typeof pose !== "object") continue;
      const base = (target.userData.scriptBase ??= { position: target.position.clone(), rotation: target.rotation.clone(), scale: target.scale.clone() }) as {
        position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3;
      };
      const p = vec(pose.position, 50);
      if (p) target.position.set(base.position.x + p[0], base.position.y + p[1], base.position.z + p[2]);
      const r = vec(pose.rotation, 36000);
      if (r) target.rotation.set(base.rotation.x + r[0] * DEG, base.rotation.y + r[1] * DEG, base.rotation.z + r[2] * DEG);
      if (pose.scale !== undefined) target.scale.copy(base.scale).multiplyScalar(Math.max(0.01, finite(pose.scale, 20)));
      if (typeof pose.visible === "boolean") target.visible = pose.visible;
      if (typeof pose.color === "string" && /^#[0-9a-fA-F]{6}$/.test(pose.color)) {
        target.traverse((m) => {
          if (!(m instanceof THREE.Mesh) || m.userData.ink) return;
          // Materials are shared between objects: recolor a copy of this one's own.
          if (!m.userData.scriptOwn) {
            m.material = (m.material as THREE.Material).clone();
            m.userData.scriptOwn = true;
            this.owned.push(m.material as THREE.Material);
          }
          (m.material as THREE.MeshStandardMaterial).color.set(pose.color!);
        });
      }
    }
  }

  dispose() {
    window.removeEventListener("message", this.onMessage);
    this.frame?.remove();
    this.frame = null;
    this.latest = [];
    for (const m of this.owned) m.dispose();
    this.owned = [];
  }
}
