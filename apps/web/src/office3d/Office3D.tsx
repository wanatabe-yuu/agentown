import { t } from "../i18n.ts";
import { t as tr } from "../i18n.ts";
import type { World } from "@agentown/core/world";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { HttpError, api } from "../api.ts";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { Agent, Snapshot, WorkState } from "../types.ts";
import { bounds, FLOOR_HEIGHT, layoutWorld, type PlacedRoom } from "./layout.ts";
import { buildNav } from "./nav.ts";
import { disposeMaterials } from "./procedural.ts";
import { lightRoom } from "./env.ts";
import { buildScene, type Flight, objectIndexOf, type OfficeScene, updateScene, workstationOf } from "./scene.ts";
import type { Draft } from "./WorldEditor.tsx";

// The editor (and its validation) is only downloaded when someone opens it.
type EditorModule = typeof import("./WorldEditor.tsx");

interface Props {
  snapshot: Snapshot;
  workOf: (a: Agent) => WorkState;
  needsOwner: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Someone picked a placed object (furniture, the shop cat…). */
  onSelectObject?: (id: string) => void;
  flights: Flight[];
  dark: boolean;
  /** May edit the world (org.design). */
  canDesign?: boolean;
  notify?: (msg: string, kind?: "error" | "info") => void;
  /** The editor wants the whole stage: the page hides its side panel meanwhile. */
  onEditingChange?: (editing: boolean) => void;
}


const VIEW = 10; // half-height of the camera's view at zoom 1, in meters
const ISO = new THREE.Vector3(1, 1.15, 1).normalize().multiplyScalar(80);

/**
 * The office in 3D: floors, rooms and objects from the organization's world,
 * an agent at each desk. Pan with the left button, turn with the right, zoom
 * with the wheel; pick a floor or a room to fly the camera there.
 */
export default function Office3D(props: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [floor, setFloor] = useState<number | "all">("all");
  const [focusRoom, setFocusRoom] = useState("");
  // Seen from above (2D, pictures) or in perspective (3D, bodies); remembered per browser.
  const [flat, setFlat] = useState(() => {
    try {
      return localStorage.getItem("agentown.view") === "2d";
    } catch {
      return false;
    }
  });
  const { snapshot } = props;

  // ---- world editor state (org.design)
  const [editing, setEditing] = useState(false);
  const [editor, setEditor] = useState<EditorModule | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [revision, setRevision] = useState(0);
  const [history, setHistory] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedObj, setSelectedObj] = useState<number | null>(null);
  const [mode, setMode] = useState<"translate" | "rotate">("translate");
  const checked = useMemo(() => (draft && editor ? editor.validate(draft, snapshot.departments.map((d) => d.id)) : null), [draft, editor, snapshot.departments]);
  const lastGood = useRef<World | null>(null);
  if (checked?.world) lastGood.current = checked.world;
  const shownWorld = editing ? (checked?.world ?? lastGood.current) : (snapshot.world ?? null);

  // Edits apply to a copy of the current draft (no state updaters: they must stay pure).
  const draftRef = useRef<Draft | null>(null);
  draftRef.current = draft;
  const edit = useCallback((fn: (w: Draft) => void) => {
    const current = draftRef.current;
    if (!current) return;
    const next = structuredClone(current);
    fn(next);
    draftRef.current = next;
    setHistory((h) => [...h.slice(-49), current]);
    setDraft(next);
    setDirty(true);
  }, []);

  // A reconnect re-reads the same world as a new object: compare contents, or everyone would be rebuilt where they started.
  const worldKey = useMemo(() => JSON.stringify(shownWorld), [shownWorld]);
  const deptKey = snapshot.departments.map((d) => `${d.id}:${d.color}`).join("|");
  const layout = useMemo(
    () => layoutWorld(shownWorld, snapshot.departments, snapshot.agents),
    // Rebuild only when the structure or the roster changes, not on every heartbeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [worldKey, deptKey, snapshot.agents.map((a) => `${a.id}:${a.departmentId}:${a.seat}:${a.lifecycleState}:${a.jobRole}`).join("|")],
  );
  const latest = useRef({ props, layout, editing, edit, floor, focusRoom, flat });
  latest.current = { props, layout, editing, edit, floor, focusRoom, flat };
  const engine = useRef<{
    renderer: THREE.WebGLRenderer;
    labels: CSS2DRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    controls: MapControls;
    office: OfficeScene | null;
    hover: string | null;
    tween: { from: THREE.Vector3; to: THREE.Vector3; z0: number; z1: number; start: number } | null;
    /** Swinging the camera between the perspective and the top-down view. */
    turn: { from: THREE.Vector3; to: THREE.Vector3; start: number; flat: boolean } | null;
    gizmo: TransformControls | null;
  } | null>(null);

  /** Fly the camera to frame these rooms. */
  const focus = (rooms: PlacedRoom[]) => {
    const e = engine.current;
    const el = wrap.current;
    if (!e || !el || !rooms.length) return;
    const b = bounds(rooms);
    const to = new THREE.Vector3((b.minX + b.maxX) / 2, b.y, (b.minZ + b.maxZ) / 2);
    // Tight framing: the world fills the stage, with just room for the labels.
    const span = (b.maxX - b.minX + (b.maxZ - b.minZ)) * 0.6 + 1.5;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    // The isometric view shows a floor plan narrower than its span: fill the width on portrait screens.
    const zoom = Math.max(0.15, Math.min(6, (2 * VIEW) / (span * 0.62 + 2), (2 * VIEW * aspect) / (span * 0.9)));
    e.tween = { from: e.controls.target.clone(), to, z0: e.camera.zoom, z1: zoom, start: performance.now() };
  };
  const visibleRooms = () => (floor === "all" ? layout.rooms : layout.rooms.filter((r) => r.floorIndex === floor));

  // Renderer, camera, controls, render loop: once.
  useEffect(() => {
    const el = wrap.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      if (!document.createElement("canvas").getContext("webgl2")) throw new Error("no WebGL 2");
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Filmic tone mapping: warm highlights (lamps, screens) roll off instead of clipping.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    el.prepend(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = "office-labels";
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const dropEnv = lightRoom(renderer, scene, 0.45);
    // Soft sky from above, warm bounce from the floor, a low warm sun for long soft shadows.
    const hemi = new THREE.HemisphereLight("#f4f1ff", "#a0846a", 1.25);
    const sun = new THREE.DirectionalLight("#fff1dc", 1.9);
    sun.position.set(28, 46, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.radius = 4;
    sun.shadow.bias = -0.0004;
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 200 });
    const fill = new THREE.DirectionalLight("#cfe0ff", 0.45);
    fill.position.set(-30, 25, -20);
    scene.add(hemi, sun, sun.target, fill);

    const camera = new THREE.OrthographicCamera(-VIEW, VIEW, VIEW, -VIEW, 0.1, 500);
    camera.position.copy(ISO);
    const controls = new MapControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    controls.minZoom = 0.15;
    controls.maxZoom = 6;
    controls.minPolarAngle = 0.35;
    controls.maxPolarAngle = 1.2;
    controls.screenSpacePanning = false;

    engine.current = { renderer, labels, scene, camera, controls, office: null, hover: null, tween: null, turn: null, gizmo: null };

    const resize = () => {
      const w = el.clientWidth;
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h);
      labels.setSize(w, h);
      const aspect = w / h;
      Object.assign(camera, { left: -VIEW * aspect, right: VIEW * aspect, top: VIEW, bottom: -VIEW });
      camera.updateProjectionMatrix();
      // Reframe on rotation or panel resizing; a desktop zoom can otherwise
      // crop the office on a phone, or leave it tiny after rotating back.
      if (engine.current?.office) {
        const { layout: l, floor: f, focusRoom: roomId } = latest.current;
        const room = l.rooms.find((r) => r.id === roomId);
        focus(room ? [room] : f === "all" ? l.rooms : l.rooms.filter((r) => r.floorIndex === f));
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let last = performance.now();
    renderer.setAnimationLoop((now) => {
      const e = engine.current!;
      const dt = Math.max(0, (now - last) / 1000);
      last = now;
      if (e.tween) {
        const k = Math.min(1, (now - e.tween.start) / 650);
        const ease = 1 - (1 - k) ** 3;
        const offset = camera.position.clone().sub(controls.target);
        controls.target.lerpVectors(e.tween.from, e.tween.to, ease);
        camera.position.copy(controls.target).add(offset);
        camera.zoom = e.tween.z0 + (e.tween.z1 - e.tween.z0) * ease;
        camera.updateProjectionMatrix();
        if (k >= 1) e.tween = null;
      }
      if (e.turn) {
        const k = Math.min(1, (now - e.turn.start) / 550);
        const ease = 1 - (1 - k) ** 3;
        const length = camera.position.distanceTo(controls.target);
        camera.position.copy(controls.target).add(e.turn.from.clone().lerp(e.turn.to, ease).normalize().multiplyScalar(length));
        if (k >= 1) {
          // Top-down: no turning; perspective: the usual range.
          controls.minPolarAngle = e.turn.flat ? 0 : 0.35;
          controls.maxPolarAngle = e.turn.flat ? 0 : 1.2;
          controls.enableRotate = !e.turn.flat;
          e.turn = null;
        }
      }
      controls.update();
      const { props: p } = latest.current;
      if (e.office) {
        updateScene(e.office, {
          agents: new Map(p.snapshot.agents.map((a) => [a.id, a])),
          workOf: p.workOf,
          needsOwner: p.needsOwner,
          selected: p.selected,
          hover: e.hover,
          flights: p.flights,
          activity: new Map((p.snapshot.objectStates ?? []).map((x) => [x.objectId, x])),
          t: now,
          clock: Date.now(),
          dt,
          frozen: latest.current.editing,
          flat: latest.current.flat && !latest.current.editing,
        });
      }
      renderer.render(scene, camera);
      labels.render(scene, camera);
    });

    // Picking: a click (not a drag) on an agent selects it.
    const ray = new THREE.Raycaster();
    /** Aim the ray; matrices are refreshed here, since frames may be paused while the page is hidden. */
    const aim = (ev: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      controls.update();
      camera.updateMatrixWorld();
      scene.updateMatrixWorld();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
    };
    const pickAt = (ev: PointerEvent): string | null => {
      const e = engine.current!;
      if (!e.office) return null;
      aim(ev);
      const picks = [...e.office.agents.values()].filter((n) => n.actor.visible).map((n) => n.pick);
      return (ray.intersectObjects(picks, false)[0]?.object.userData.agentId as string | undefined) ?? null;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => (down = { x: ev.clientX, y: ev.clientY });
    const onUp = (ev: PointerEvent) => {
      if (ev.button === 0 && down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4 && !engine.current?.gizmo?.dragging) {
        if (latest.current.editing) {
          // Editing: pick a placed object, or the room whose floor was clicked.
          const e = engine.current!;
          aim(ev);
          const hits = e.office ? ray.intersectObject(e.office.root, true).filter((h) => h.object.visible && (h.object as THREE.Mesh).isMesh) : [];
          const obj = hits.map((h) => objectIndexOf(h.object)).find((i) => i !== null);
          if (obj !== undefined && obj !== null) setSelectedObj(obj);
          else {
            const room = hits.find((h) => h.object.userData.roomId)?.object.userData.roomId as string | undefined;
            setSelectedObj(null);
            if (room) setFocusRoom(room);
          }
        } else {
          const id = pickAt(ev);
          if (id) latest.current.props.onSelect(id);
          else if (latest.current.props.onSelectObject) {
            aim(ev);
            const e = engine.current!;
            const hits = e.office ? ray.intersectObject(e.office.root, true).filter(h => h.object.visible && (h.object as THREE.Mesh).isMesh) : [];
            // The nearest thing hit: a placed object, or someone's workstation.
            for (const h of hits) {
              const index = objectIndexOf(h.object);
              const object = index != null ? latest.current.props.snapshot.world?.objects[index] : undefined;
              const desk = workstationOf(h.object);
              if (object?.id) latest.current.props.onSelectObject(object.id);
              else if (desk) latest.current.props.onSelectObject(`desk:${desk}`);
              else continue;
              break;
            }
          }
        }
      }
      down = null;
    };
    const onMove = (ev: PointerEvent) => {
      if (down) return;
      const id = pickAt(ev);
      engine.current!.hover = id;
      renderer.domElement.style.cursor = id ? "pointer" : "grab";
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointermove", onMove);

    return () => {
      ro.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      renderer.domElement.removeEventListener("pointermove", onMove);
      engine.current?.office?.dispose();
      controls.dispose();
      disposeMaterials();
      dropEnv();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
      labels.domElement.remove();
      engine.current = null;
    };
  }, []);

  // Scene graph: rebuilt when the layout changes.
  const firstFit = useRef(true);
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    const previous = e.office;
    const office = buildScene(layout, snapshot.world ?? null, snapshot.departments, snapshot.agents, buildNav(snapshot.world ?? null, layout), (roomId) => {
      setFocusRoom(roomId);
      const room = layout.rooms.find((r) => r.id === roomId);
      if (room) focus([room]);
    }, previous);
    previous?.dispose();
    e.scene.add(office.root);
    e.office = office;
    if (firstFit.current) {
      firstFit.current = false;
      const start = layout.floors.length > 1 ? 0 : "all";
      setFloor(start);
      focus(start === "all" ? layout.rooms : layout.rooms.filter((r) => r.floorIndex === 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  // 2D / 3D: swing the camera over or back.
  useEffect(() => {
    try {
      localStorage.setItem("agentown.view", flat ? "2d" : "3d");
    } catch {}
    const e = engine.current;
    if (!e) return;
    e.controls.minPolarAngle = 0;
    e.controls.maxPolarAngle = 1.2;
    const from = e.camera.position.clone().sub(e.controls.target).normalize();
    e.turn = { from, to: flat ? new THREE.Vector3(0, 1, 0.0001) : ISO.clone().normalize(), start: performance.now(), flat };
    // Floors stacked on top of each other cannot be seen from above: show one.
    if (flat && floor === "all" && layout.floors.length > 1) {
      setFloor(0);
      focus(layout.rooms.filter((r) => r.floorIndex === 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flat]);

  // Floor filter: show one floor, or all of them stacked.
  useEffect(() => {
    const office = engine.current?.office;
    if (!office) return;
    for (const [i, g] of office.floors) g.visible = floor === "all" || floor === i;
  }, [floor, layout]);

  // Room focus (from the list or a click on a room's name).
  useEffect(() => {
    const room = layout.rooms.find((r) => r.id === focusRoom);
    if (!room) return;
    if (floor !== "all" && floor !== room.floorIndex) setFloor(room.floorIndex);
    focus([room]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRoom]);

  // Move/turn handles while editing, attached to the selected object after every rebuild.
  useEffect(() => {
    const e = engine.current;
    if (!e) return;
    if (!editing) {
      e.gizmo?.detach();
      e.gizmo?.getHelper().removeFromParent();
      e.gizmo?.dispose();
      e.gizmo = null;
      return;
    }
    if (!e.gizmo) {
      const g = new TransformControls(e.camera, e.renderer.domElement);
      g.setTranslationSnap(0.25);
      g.setRotationSnap(Math.PI / 12);
      g.addEventListener("dragging-changed", (ev) => (e.controls.enabled = !ev.value));
      g.addEventListener("mouseUp", () => {
        const o = g.object;
        const i = o ? objectIndexOf(o) : null;
        if (!o || i === null) return;
        const { layout: l } = latest.current;
        const floor = Math.round(o.position.y / FLOOR_HEIGHT);
        latest.current.edit((w) => {
          const placed = w.objects[i];
          const room =
            l.rooms.find((r) => r.floorIndex === floor && o.position.x >= r.x && o.position.x <= r.x + r.w && o.position.z >= r.z && o.position.z <= r.z + r.d) ??
            l.rooms.find((r) => r.id === placed.room)!;
          placed.room = room.id;
          placed.at = [+Math.min(room.w, Math.max(0, o.position.x - room.x)).toFixed(2), +Math.min(room.d, Math.max(0, o.position.z - room.z)).toFixed(2)];
          placed.rotationY = Math.round((o.rotation.y * 180) / Math.PI);
        });
      });
      e.scene.add(g.getHelper());
      e.gizmo = g;
    }
    e.gizmo.setMode(mode);
    e.gizmo.showY = mode === "rotate";
    e.gizmo.showX = e.gizmo.showZ = mode === "translate";
    let target: THREE.Object3D | null = null;
    if (selectedObj !== null) e.office?.root.traverse((o) => {
      if (!target && o.userData.objectIndex === selectedObj) target = o;
    });
    if (target) e.gizmo.attach(target);
    else e.gizmo.detach();
  }, [editing, selectedObj, mode, layout]);

  // Ctrl+Z while editing (not while typing in a field).
  const historyRef = useRef<Draft[]>([]);
  historyRef.current = history;
  const undo = useCallback(() => {
    const h = historyRef.current;
    if (!h.length) return;
    setDraft(h.at(-1)!);
    setHistory(h.slice(0, -1));
  }, []);
  useEffect(() => {
    if (!editing) return;
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === "z" && !(ev.target instanceof HTMLInputElement || ev.target instanceof HTMLSelectElement)) {
        ev.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, undo]);

  const notify = props.notify ?? (() => {});
  const startEditing = async () => {
    try {
      if (!editor) setEditor(await import("./WorldEditor.tsx"));
      const r = await api<{ revision: number; world: Draft | null }>("GET", "/api/world");
      // No world yet: start from today's layout (one room per department).
      const base: Draft = r.world ?? {
        floors: [{ id: "main", name: "Office", rooms: layout.rooms.map((rm) => ({ id: rm.id, name: rm.name, department: rm.department ?? undefined, area: { x: rm.x, z: rm.z, w: rm.w, d: rm.d } })) }],
        kinds: {},
        objects: [],
      };
      setDraft(structuredClone(base));
      setRevision(r.revision);
      setHistory([]);
      setDirty(!r.world);
      setSelectedObj(null);
      setFlat(false);
      setEditing(true);
      props.onEditingChange?.(true);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };
  const stopEditing = () => {
    if (dirty && !confirm("Discard your changes to the world?")) return;
    setEditing(false);
    setDraft(null);
    setSelectedObj(null);
    props.onEditingChange?.(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      const r = await api<{ revision: number }>("PUT", "/api/world", { revision, world: draft });
      setRevision(r.revision);
      setDirty(false);
      notify("World saved", "info");
    } catch (e) {
      notify(e instanceof HttpError && e.status === 409 ? "Someone changed the organization meanwhile: close the editor and open it again." : (e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  if (failed) return <NoWebGL {...props} />;

  const zoomBy = (k: number) => {
    const e = engine.current;
    if (!e) return;
    e.tween = { from: e.controls.target.clone(), to: e.controls.target.clone(), z0: e.camera.zoom, z1: Math.max(0.15, Math.min(6, e.camera.zoom * k)), start: performance.now() };
  };
  return (
    <div ref={wrap} className="office-canvas office-3d" aria-label="Office in 3D; select an agent to open its panel">
      <div className="world-nav">
        {layout.floors.length > 1 && (
          <div className="seg-toggle" role="group" aria-label={tr("Floor")}>
            <button type="button" className={floor === "all" ? "active" : ""} onClick={() => (setFloor("all"), focus(layout.rooms))}>
              {t("All")}
            </button>
            {layout.floors.map((f) => (
              <button
                key={f.id}
                type="button"
                className={floor === f.index ? "active" : ""}
                onClick={() => {
                  setFloor(f.index);
                  setFocusRoom("");
                  focus(layout.rooms.filter((r) => r.floorIndex === f.index));
                }}
              >
                {f.name}
              </button>
            ))}
          </div>
        )}
        {props.canDesign && !editing && (
          <button type="button" className="edit-world" onClick={() => void startEditing()}>
            {t("Edit world")}
          </button>
        )}
        <select
          value={focusRoom}
          onChange={(ev) => {
            setFocusRoom(ev.target.value);
            if (!ev.target.value) focus(visibleRooms());
          }}
          aria-label={t("Focus a room")}
        >
          <option value="">{layout.floors.length > 1 ? t("Rooms…") : t("All rooms")}</option>
          {layout.floors.map((f) => (
            <optgroup key={f.id} label={f.name}>
              {layout.rooms
                .filter((r) => r.floorIndex === f.index)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </div>
      {editing && draft && editor && (
        <editor.EditorHost
          draft={draft}
          edit={edit}
          errors={checked?.errors ?? []}
          dirty={dirty}
          saving={saving}
          selected={selectedObj}
          setSelected={setSelectedObj}
          roomId={focusRoom}
          setRoomId={setFocusRoom}
          mode={mode}
          setMode={setMode}
          departments={snapshot.departments}
          jobRoles={[...new Set(snapshot.agents.map((a) => a.jobRole))].sort()}
          onSave={() => void save()}
          onDiscard={stopEditing}
          onUndo={undo}
          canUndo={history.length > 0}
          notify={notify}
        />
      )}
      {!editing && (
        <div className="view-mode" role="group" aria-label={tr("View")}>
          <button type="button" className={flat ? "" : "active"} aria-pressed={!flat} onClick={() => setFlat(false)} title={tr("3D: people and things as they are")}>
            3D
          </button>
          <button type="button" className={flat ? "active" : ""} aria-pressed={flat} onClick={() => setFlat(true)} title={tr("2D: from above, everyone as their picture")}>
            2D
          </button>
        </div>
      )}
      <div className={`zoom-controls ${editing ? "editing" : ""}`}>
        <button type="button" onClick={() => zoomBy(1.25)} aria-label={tr("Zoom in")}>
          +
        </button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label={tr("Zoom out")}>
          −
        </button>
        <button
          type="button"
          onClick={() => {
            setFocusRoom("");
            focus(visibleRooms());
          }}
          aria-label={tr("Fit to screen")}
        >
          ⤢
        </button>
      </div>
    </div>
  );
}

/** Without WebGL: the same people, by department, and how to turn the 3D office on. */
function NoWebGL({ snapshot, workOf, onSelect }: Props) {
  return (
    <div className="office-canvas no-webgl">
      <div className="notice">
        <div>
          <b>{tr("The 3D office cannot start in this browser.")}</b>
          <p className="muted small">
            {tr("It needs WebGL 2. Turn on hardware acceleration (Chrome/Edge: Settings → System → “Use graphics acceleration when available”), then reload. Everyone is listed below meanwhile.")}
          </p>
        </div>
        <button type="button" onClick={() => location.reload()}>
          {tr("Try again")}
        </button>
      </div>
      <div className="dept-cards">
        {snapshot.departments.map((d) => {
          const people = snapshot.agents.filter((a) => a.departmentId === d.id && a.lifecycleState !== "retired");
          if (!people.length) return null;
          return (
            <section key={d.id} className="dept-card" style={{ "--dept": d.color } as React.CSSProperties}>
              <h3>{d.name}</h3>
              {people.map((a) => (
                <button key={a.id} type="button" className="person" onClick={() => onSelect(a.id)}>
                  <span className="avatar-sm" aria-hidden>
                    {a.displayName.slice(0, 1)}
                  </span>
                  <span>
                    <b>{a.displayName}</b>
                    <small className="muted">
                      {a.jobRole} · {workOf(a)}
                    </small>
                  </span>
                </button>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
