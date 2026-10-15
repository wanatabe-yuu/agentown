import { type AvatarOverride, CHARACTERS, type World } from "@agentown/core/world";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import type { Agent, WorkState } from "../types.ts";
import { StatusPill } from "../ui.tsx";
import { loadModels } from "./assets.ts";
import { chair, desk, monitor } from "./procedural.ts";
import { agentAvatar, animateAvatar, SCREEN } from "./scene.ts";

const BUILT_IN: Record<(typeof CHARACTERS)[number], string> = { person: "Person", cat: "Cat", dog: "Dog", robot: "Robot" };

/**
 * One agent at its desk, in 3D, doing what it is doing now: the same character
 * as in the office, turning slowly so it can be looked at from every side.
 * People who may design the world can change how this one agent looks.
 */
export default function AgentStudio(p: {
  agent: Agent;
  world: World | null;
  deptColor: string;
  work: WorkState;
  activity: string | null;
  canDesign: boolean;
  notify: (msg: string, kind?: "error" | "info") => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const holder = useRef<THREE.Group | null>(null);
  const live = useRef({ work: p.work, runtime: p.agent.runtime?.state ?? "none" });
  live.current = { work: p.work, runtime: p.agent.runtime?.state ?? "none" };
  const saved = p.world?.avatars.byAgent?.[p.agent.id] ?? {};
  const [draft, setDraft] = useState<AvatarOverride | null>(null);
  const look = draft ?? saved;
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => setDraft(null), [p.agent.id]);

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
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#ffffff", "#8a7f74", 1.5));
    const sun = new THREE.DirectionalLight("#ffffff", 1.7);
    sun.position.set(2, 5, 3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    scene.add(sun);
    const floorGeo = new THREE.CircleGeometry(1.6, 48);
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
    actor.position.z = 0.3;
    scene.add(actor);
    holder.current = actor;

    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    camera.position.set(2.6, 1.85, 2.3);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(0, 0.8, 0);
    controls.enablePan = false;
    controls.enableZoom = false;
    // Turn around it only: vertical swipes keep scrolling the panel.
    controls.minPolarAngle = controls.maxPolarAngle = 1.15;
    controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controls.autoRotateSpeed = 1.6;
    renderer.domElement.style.touchAction = "pan-y";

    const size = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    let frame = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const { work, runtime } = live.current;
      const sec = now / 1000;
      const avatar = actor.children[0];
      if (avatar) animateAvatar(avatar, work, sec);
      screen.color.set(SCREEN[runtime] ?? SCREEN.unknown!);
      screen.emissive.set(SCREEN[runtime] ?? "#000000");
      screen.emissiveIntensity = work === "executing" ? 0.55 + 0.35 * Math.sin(sec * 9) : runtime === "running" ? 0.35 : 0.15;
      controls.update();
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      screen.dispose();
      renderer.dispose();
      renderer.domElement.remove();
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
    const { avatar } = agentAvatar(p.agent, world, p.deptColor);
    actor.add(avatar);
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
    <section className="studio">
      <div className="studio-stage" ref={wrap}>
        {failed && <p className="muted small studio-fallback">{t("The 3D office cannot start in this browser.")}</p>}
        <div className="studio-caption">
          <StatusPill state={p.work} />
          {p.activity && <span className="studio-activity">{p.activity}</span>}
        </div>
      </div>
      {p.canDesign && p.world && (
        <details className="studio-look" open={changed || undefined}>
          <summary>{t("Look")}</summary>
          <div className="look-grid">
            <label>
              {t("Character")}
              <select
                value={choice}
                onChange={(e) => {
                  const v = e.target.value;
                  set({ kind: v.startsWith("kind:") ? v.slice(5) : undefined, character: v.startsWith("builtin:") ? (v.slice(8) as AvatarOverride["character"]) : undefined });
                }}
              >
                <option value="">{t("From the template")}{jobKind && p.world.kinds[jobKind] ? ` (${p.world.kinds[jobKind]!.name})` : ""}</option>
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
          </div>
          <div className="btn-row">
            <button type="button" className="primary" disabled={!changed || busy} onClick={() => void save(draft)}>
              {t("Save look")}
            </button>
            {changed && (
              <button type="button" disabled={busy} onClick={() => setDraft(null)}>
                {t("Cancel")}
              </button>
            )}
            {!changed && Object.keys(saved).length > 0 && (
              <button type="button" disabled={busy} onClick={() => void save(null)}>
                {t("Back to the template's look")}
              </button>
            )}
          </div>
        </details>
      )}
    </section>
  );
}
