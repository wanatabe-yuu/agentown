import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { MapControls } from "three/addons/controls/MapControls.js";
import { CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { Agent, Snapshot, WorkState } from "../types.ts";
import { bounds, layoutWorld, type PlacedRoom } from "./layout.ts";
import { disposeMaterials } from "./procedural.ts";
import { buildScene, type Flight, type OfficeScene, updateScene } from "./scene.ts";

interface Props {
  snapshot: Snapshot;
  workOf: (a: Agent) => WorkState;
  needsOwner: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  flights: Flight[];
  dark: boolean;
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
  const { snapshot } = props;
  const layout = useMemo(
    () => layoutWorld(snapshot.world ?? null, snapshot.departments, snapshot.agents),
    // Rebuild only when the structure or the roster changes, not on every heartbeat.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot.world, snapshot.departments, snapshot.agents.map((a) => `${a.id}:${a.departmentId}:${a.seat}:${a.lifecycleState}:${a.jobRole}`).join("|")],
  );
  const latest = useRef({ props, layout });
  latest.current = { props, layout };
  const engine = useRef<{
    renderer: THREE.WebGLRenderer;
    labels: CSS2DRenderer;
    scene: THREE.Scene;
    camera: THREE.OrthographicCamera;
    controls: MapControls;
    office: OfficeScene | null;
    hover: string | null;
    tween: { from: THREE.Vector3; to: THREE.Vector3; z0: number; z1: number; start: number } | null;
  } | null>(null);

  /** Fly the camera to frame these rooms. */
  const focus = (rooms: PlacedRoom[]) => {
    const e = engine.current;
    const el = wrap.current;
    if (!e || !el || !rooms.length) return;
    const b = bounds(rooms);
    const to = new THREE.Vector3((b.minX + b.maxX) / 2, b.y, (b.minZ + b.maxZ) / 2);
    const span = (b.maxX - b.minX + (b.maxZ - b.minZ)) * 0.72 + 3;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    const zoom = Math.max(0.15, Math.min(6, (2 * VIEW) / (span * 0.62 + 2), (2 * VIEW * aspect) / span));
    e.tween = { from: e.controls.target.clone(), to, z0: e.camera.zoom, z1: zoom, start: performance.now() };
  };
  const visibleRooms = () => (floor === "all" ? layout.rooms : layout.rooms.filter((r) => r.floorIndex === floor));

  // Renderer, camera, controls, render loop: once.
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
    el.prepend(renderer.domElement);
    const labels = new CSS2DRenderer();
    labels.domElement.className = "office-labels";
    el.appendChild(labels.domElement);

    const scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight("#ffffff", "#8a7f74", 1.4);
    const sun = new THREE.DirectionalLight("#ffffff", 1.6);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, far: 200 });
    scene.add(hemi, sun, sun.target);

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

    engine.current = { renderer, labels, scene, camera, controls, office: null, hover: null, tween: null };

    const resize = () => {
      const w = el.clientWidth;
      const h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h);
      labels.setSize(w, h);
      const aspect = w / h;
      Object.assign(camera, { left: -VIEW * aspect, right: VIEW * aspect, top: VIEW, bottom: -VIEW });
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    renderer.setAnimationLoop((now) => {
      const e = engine.current!;
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
          t: now,
        });
      }
      renderer.render(scene, camera);
      labels.render(scene, camera);
    });

    // Picking: a click (not a drag) on an agent selects it.
    const ray = new THREE.Raycaster();
    const pickAt = (ev: PointerEvent): string | null => {
      const e = engine.current!;
      if (!e.office) return null;
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1), camera);
      const picks = [...e.office.agents.values()].filter((n) => e.office!.floors.get(n.floorIndex)?.visible).map((n) => n.pick);
      return (ray.intersectObjects(picks, false)[0]?.object.userData.agentId as string | undefined) ?? null;
    };
    let down: { x: number; y: number } | null = null;
    const onDown = (ev: PointerEvent) => (down = { x: ev.clientX, y: ev.clientY });
    const onUp = (ev: PointerEvent) => {
      if (ev.button === 0 && down && Math.hypot(ev.clientX - down.x, ev.clientY - down.y) < 4) {
        const id = pickAt(ev);
        if (id) latest.current.props.onSelect(id);
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
    e.office?.dispose();
    const office = buildScene(layout, snapshot.world ?? null, snapshot.departments, snapshot.agents, (roomId) => {
      setFocusRoom(roomId);
      const room = layout.rooms.find((r) => r.id === roomId);
      if (room) focus([room]);
    });
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
          <div className="seg-toggle" role="group" aria-label="Floor">
            <button type="button" className={floor === "all" ? "active" : ""} onClick={() => (setFloor("all"), focus(layout.rooms))}>
              All
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
        <select
          value={focusRoom}
          onChange={(ev) => {
            setFocusRoom(ev.target.value);
            if (!ev.target.value) focus(visibleRooms());
          }}
          aria-label="Focus a room"
        >
          <option value="">{layout.floors.length > 1 ? "Rooms…" : "All rooms"}</option>
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
      <div className="zoom-controls">
        <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          onClick={() => {
            setFocusRoom("");
            focus(visibleRooms());
          }}
          aria-label="Fit to screen"
        >
          ⤢
        </button>
      </div>
    </div>
  );
}

/** Without WebGL: the same people, as a list by department. */
function NoWebGL({ snapshot, workOf, onSelect }: Props) {
  return (
    <div className="office-canvas no-webgl">
      <p className="muted">The 3D office needs WebGL, which this browser has turned off. Here is everyone by department:</p>
      {snapshot.departments.map((d) => (
        <section key={d.id}>
          <h3 style={{ color: d.color }}>{d.name}</h3>
          <ul className="task-list">
            {snapshot.agents
              .filter((a) => a.departmentId === d.id && a.lifecycleState !== "retired")
              .map((a) => (
                <li key={a.id}>
                  <button type="button" className="task-row" onClick={() => onSelect(a.id)}>
                    <span className="task-title">{a.displayName}</span>
                    <span className="muted small">
                      {a.jobRole} · {workOf(a)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
