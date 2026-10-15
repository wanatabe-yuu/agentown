import { type AvatarOverride, CHARACTERS, type World } from "@agentown/core/world";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import type { Agent, WorkState } from "../types.ts";
import { StatusPill } from "../ui.tsx";
import { loadModels } from "./assets.ts";
import { lightRoom } from "./env.ts";
import { chair, desk, monitor } from "./procedural.ts";
import { agentAvatar, animateAvatar, SCREEN, swingLegs } from "./scene.ts";

const BUILT_IN: Record<(typeof CHARACTERS)[number], string> = { person: "Person", cat: "Cat", dog: "Dog", robot: "Robot" };

/** What the stage can show the character doing: "live" follows the agent right now. */
type Action = "live" | "idle" | "thinking" | "executing" | "waiting" | "blocked" | "error" | "walking" | "offline";
const ACTIONS: Array<{ id: Action; label: string }> = [
  { id: "live", label: "Right now" },
  { id: "idle", label: "Idle" },
  { id: "thinking", label: "Thinking it over" },
  { id: "executing", label: "Working" },
  { id: "waiting", label: "Waiting" },
  { id: "blocked", label: "Blocked" },
  { id: "error", label: "Error" },
  { id: "walking", label: "Walking around" },
  { id: "offline", label: "Offline" },
];
/** The same bubbles as over heads in the office. */
const BUBBLE: Partial<Record<string, [string, string]>> = { blocked: ["!", "bad"], error: ["×", "bad"], waiting: ["⌛", "plain"] };

const SEAT = { x: 0, z: 0.3 };
// Beside the chair, a little left of center: still in view with the look panel open on the right.
const STROLL = { x: 0.75, z: 0.35 };
/** How much of the stage must stay in view around the character, in meters. */
const FIT_RADIUS = 1.25;

/**
 * One agent at its desk, in 3D: the same character as in the office, standing
 * still so its look can be judged, acting out whatever is picked (what it does
 * right now by default). Its own look sits beside it, for people who may
 * design the world.
 */
export default function AgentStudio(p: {
  agent: Agent;
  world: World | null;
  deptColor: string;
  work: WorkState;
  activity: string | null;
  canDesign: boolean;
  notify: (msg: string, kind?: "error" | "info") => void;
  /** Scrolls to what is below the stage. */
  onMore: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const holder = useRef<THREE.Group | null>(null);
  const [action, setAction] = useState<Action>("live");
  const shown = action === "live" ? p.work : action;
  const live = useRef({ work: shown as string, runtime: p.agent.runtime?.state ?? "none" });
  live.current = { work: shown, runtime: action === "live" ? (p.agent.runtime?.state ?? "none") : action === "offline" ? "stopped" : "running" };
  const saved = p.world?.avatars.byAgent?.[p.agent.id] ?? {};
  const [draft, setDraft] = useState<AvatarOverride | null>(null);
  const look = draft ?? saved;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [presetOpen, setPresetOpen] = useState(() => window.matchMedia("(min-width: 701px)").matches);
  const presetRef = useRef(presetOpen);
  presetRef.current = presetOpen && p.canDesign && !!p.world;

  useEffect(() => {
    setDraft(null);
    setAction("live");
  }, [p.agent.id]);

  // The stage: built once per panel, torn down with it.
  useEffect(() => {
    const el = wrap.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    el.prepend(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = "studio-labels";
    el.prepend(labels.domElement);

    const scene = new THREE.Scene();
    const dropEnv = lightRoom(renderer, scene);
    scene.add(new THREE.HemisphereLight("#ffffff", "#8a7f74", 1.5));
    const sun = new THREE.DirectionalLight("#ffffff", 1.7);
    sun.position.set(2, 5, -1);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const floorGeo = new THREE.CircleGeometry(1.7, 48);
    const floorMat = new THREE.MeshStandardMaterial({ color: "#b8b1a5", roughness: 0.9 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const d = desk();
    d.position.z = -0.35;
    const { group: mon, screen } = monitor();
    mon.position.z = -0.35;
    const c = chair();
    c.position.z = 0.35;
    scene.add(d, mon, c);
    const actor = new THREE.Group();
    actor.position.set(SEAT.x, 0, SEAT.z);
    scene.add(actor);
    holder.current = actor;
    const bubbleEl = document.createElement("div");
    bubbleEl.className = "agent-bubble";
    const bubble = new CSS2DObject(bubbleEl);
    scene.add(bubble);

    // From the side of the desk, a little in front: the face, the hands and the screen, with the monitor out of the way.
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);
    camera.position.set(2.6, 1.45, -0.7);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0.15, 0.75, 0.1);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableDamping = true;
    controls.update();
    // Turn around it only: vertical swipes keep scrolling the panel.
    controls.minPolarAngle = controls.maxPolarAngle = controls.getPolarAngle();
    renderer.domElement.style.touchAction = "pan-y";

    let w = 1;
    let h = 1;
    const size = () => {
      w = Math.max(1, el.clientWidth);
      h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      labels.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // Keep the desk and the character in frame whatever the shape of the stage (tall on phones).
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = FIT_RADIUS / Math.sin(Math.min(vfov, hfov) / 2);
      const offset = camera.position.clone().sub(controls.target).setLength(dist);
      camera.position.copy(controls.target).add(offset);
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    let frame = 0;
    let shift = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const { work, runtime } = live.current;
      const sec = now / 1000;
      const avatar = actor.children[0];
      const walking = work === "walking";
      actor.visible = work !== "offline";
      if (walking) {
        actor.position.set(STROLL.x, 0, STROLL.z);
        actor.rotation.y = -1.06; // toward the camera
      } else {
        actor.position.set(SEAT.x, 0, SEAT.z);
        actor.rotation.y = 0;
      }
      if (avatar) {
        animateAvatar(avatar, walking ? "idle" : work, sec, walking ? -((avatar.userData.lift as number | undefined) ?? 0) * avatar.scale.y : 0, walking);
        swingLegs(avatar, walking ? Math.sin(sec * 9) * 0.6 : 0);
      }
      screen.color.set(SCREEN[runtime] ?? SCREEN.unknown!);
      screen.emissive.set(SCREEN[runtime] ?? "#000000");
      screen.emissiveIntensity = work === "executing" ? 0.55 + 0.35 * Math.sin(sec * 9) : runtime === "running" ? 0.35 : 0.15;
      const [text, tone] = work === "thinking" ? [".".repeat(1 + (Math.floor(now / 400) % 3)), "plain"] : (BUBBLE[work] ?? ["", ""]);
      if (bubbleEl.textContent !== text) bubbleEl.textContent = text;
      bubbleEl.dataset.tone = tone;
      bubbleEl.style.display = text && actor.visible ? "" : "none";
      bubble.position.set(actor.position.x + 0.4, 1.75, actor.position.z - 0.1);
      // With the look panel open on the right, the character moves into the space left of it.
      const target = presetRef.current ? w * 0.22 : 0;
      shift += (target - shift) * 0.15;
      camera.setViewOffset(w, h, shift, 0, w, h);
      controls.update();
      renderer.render(scene, camera);
      labels.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      screen.dispose();
      dropEnv();
      renderer.dispose();
      // Give the context back now: browsers keep only a few, and the office needs its own.
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labels.domElement.remove();
      holder.current = null;
    };
  }, []);

  // The character itself: rebuilt whenever its look changes (a draft shows right away).
  const lookKey = JSON.stringify([p.agent.id, p.agent.jobRole, p.deptColor, look, p.world?.avatars, p.world?.kinds]);
  useEffect(() => {
    const actor = holder.current;
    if (!actor) return;
    actor.clear();
    const world = p.world ? { ...p.world, avatars: { ...p.world.avatars, byAgent: { ...p.world.avatars.byAgent, [p.agent.id]: look } } } : null;
    actor.add(agentAvatar(p.agent, world, p.deptColor).avatar);
    let alive = true;
    loadModels(actor, [], () => alive);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookKey]);

  const characterKinds = Object.entries(p.world?.kinds ?? {}).filter(([, k]) => k.category === "character");
  const choice = look.character ? `builtin:${look.character}` : look.kind ? `kind:${look.kind}` : "";
  const jobKind = p.world?.avatars.byJobRole[p.agent.jobRole] ?? p.world?.avatars.default;
  const shownKind = look.kind ?? jobKind;
  const colorable = !!look.character || !shownKind || (p.world?.kinds[shownKind] && "character" in p.world.kinds[shownKind]!.look);
  const changed = draft !== null && JSON.stringify(draft) !== JSON.stringify(saved);
  const canEdit = p.canDesign && !!p.world;

  const save = async (next: AvatarOverride | null) => {
    setBusy(true);
    try {
      const cur = await api<{ revision: number; world: World | null }>("GET", "/api/world");
      if (!cur.world) throw new Error(t("This organization has no world to save into."));
      const byAgent = { ...(cur.world.avatars?.byAgent ?? {}) };
      if (next && Object.keys(next).length) byAgent[p.agent.id] = next;
      else delete byAgent[p.agent.id];
      await api("PUT", "/api/world", { revision: cur.revision, world: { ...cur.world, avatars: { ...cur.world.avatars, byAgent } } });
      setDraft(null);
      p.notify(t("Look of {name} saved", { name: p.agent.displayName }), "info");
    } catch (e) {
      p.notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const set = (patch: Partial<AvatarOverride>) => {
    const next = { ...look, ...patch };
    for (const k of Object.keys(next) as Array<keyof AvatarOverride>) if (next[k] === undefined) delete next[k];
    setDraft(next);
  };

  return (
    <section className={`studio${canEdit && presetOpen ? " preset-open" : ""}`}>
      <div className="studio-stage" ref={wrap}>
        {failed && <p className="muted small studio-fallback">{t("The 3D office cannot start in this browser.")}</p>}
        <label className="studio-action">
          <span className="sr-only">{t("Action")}</span>
          <select value={action} onChange={(e) => setAction(e.target.value as Action)} aria-label={t("Show the character")}>
            {ACTIONS.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id === "live" ? `${t(a.label)} · ${t(p.work)}` : t(a.label)}
              </option>
            ))}
          </select>
        </label>
        <div className="studio-caption">
          {action === "live" ? (
            <>
              <StatusPill state={p.work} />
              {p.activity && <span className="studio-activity">{p.activity}</span>}
            </>
          ) : (
            <span className="studio-activity">{t("Preview")}</span>
          )}
        </div>
        <button type="button" className="studio-more" onClick={p.onMore} aria-label={t("More below")}>
          ⌄
        </button>

        {canEdit && (
          <aside className={`studio-preset${presetOpen ? " open" : ""}`} aria-label={t("Look")}>
            <button type="button" className="studio-preset-toggle" aria-expanded={presetOpen} onClick={() => setPresetOpen((x) => !x)}>
              {presetOpen ? `${t("Look")} ›` : `‹ ${t("Look")}`}
            </button>
            {presetOpen && (
              <div className="studio-preset-body">
                <label>
                  {t("Character")}
                  <select
                    value={choice}
                    onChange={(e) => {
                      const v = e.target.value;
                      set({ kind: v.startsWith("kind:") ? v.slice(5) : undefined, character: v.startsWith("builtin:") ? (v.slice(8) as AvatarOverride["character"]) : undefined });
                    }}
                  >
                    <option value="">
                      {t("From the template")}
                      {jobKind && p.world!.kinds[jobKind] ? ` (${p.world!.kinds[jobKind]!.name})` : ""}
                    </option>
                    {characterKinds.length > 0 && (
                      <optgroup label={t("This world's characters")}>
                        {characterKinds.map(([id, k]) => (
                          <option key={id} value={`kind:${id}`}>
                            {k.name}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    <optgroup label={t("Built-in")}>
                      {CHARACTERS.map((c) => (
                        <option key={c} value={`builtin:${c}`}>
                          {t(BUILT_IN[c])}
                        </option>
                      ))}
                    </optgroup>
                  </select>
                </label>
                {colorable && (
                  <>
                    <label>
                      {t("Main color")}
                      <span className="color-row">
                        <input type="color" value={look.color ?? p.deptColor} onChange={(e) => set({ color: e.target.value })} />
                        {look.color && (
                          <button type="button" className="link" onClick={() => set({ color: undefined })}>
                            {t("default")}
                          </button>
                        )}
                      </span>
                    </label>
                    <label>
                      {t("Accent (hair, legs)")}
                      <span className="color-row">
                        <input type="color" value={look.accent ?? "#3b2a20"} onChange={(e) => set({ accent: e.target.value })} />
                        {look.accent && (
                          <button type="button" className="link" onClick={() => set({ accent: undefined })}>
                            {t("default")}
                          </button>
                        )}
                      </span>
                    </label>
                  </>
                )}
                <div className="btn-row">
                  <button type="button" className="primary" disabled={!changed || busy} onClick={() => void save(draft)}>
                    {t("Save look")}
                  </button>
                  {changed && (
                    <button type="button" disabled={busy} onClick={() => setDraft(null)}>
                      {t("Cancel")}
                    </button>
                  )}
                </div>
                {!changed && Object.keys(saved).length > 0 && (
                  <button type="button" className="link" disabled={busy} onClick={() => void save(null)}>
                    {t("Back to the template's look")}
                  </button>
                )}
              </div>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}
