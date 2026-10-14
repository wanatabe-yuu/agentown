import type { Behavior, World } from "@agentown/core";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Agent, Department, WorkState } from "../types.ts";
import type { PlacedRoom, Seat, WorldLayout } from "./layout.ts";
import { chair, character, desk, lookObject, monitor } from "./procedural.ts";

/** A task handed from one agent to another: a sheet of paper flies between their desks. */
export interface Flight {
  from: string;
  to: string;
  start: number;
  label: string;
}

const SCREEN: Record<string, string> = {
  running: "#4ade80",
  pending: "#facc15",
  restarting: "#fb923c",
  failed: "#ef4444",
  stopped: "#475569",
  none: "#334155",
  unknown: "#a78bfa",
};
const TAU = Math.PI * 2;

export interface AgentNode {
  id: string;
  seat: Seat;
  root: THREE.Group;
  avatar: THREE.Group;
  pick: THREE.Mesh;
  ring: THREE.Mesh;
  screen: THREE.MeshStandardMaterial;
  label: HTMLDivElement;
  bubble: HTMLDivElement;
  floorIndex: number;
}

interface Animated {
  target: THREE.Object3D;
  behavior: Behavior;
  base: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 };
  materials: THREE.MeshStandardMaterial[];
  room: PlacedRoom;
  seed: number;
}

export interface OfficeScene {
  root: THREE.Group;
  floors: Map<number, THREE.Group>;
  agents: Map<string, AgentNode>;
  animated: Animated[];
  paper: THREE.Mesh;
  dispose(): void;
}

function label(className: string, text: string): { el: HTMLDivElement; obj: CSS2DObject } {
  const el = document.createElement("div");
  el.className = className;
  el.textContent = text;
  return { el, obj: new CSS2DObject(el) };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}

function roomMesh(room: PlacedRoom): THREE.Group {
  const g = new THREE.Group();
  g.position.set(room.x, room.y, room.z);
  const floor = new THREE.Mesh(new THREE.BoxGeometry(room.w, 0.12, room.d), new THREE.MeshStandardMaterial({ color: room.floorColor, roughness: 0.9 }));
  floor.position.set(room.w / 2, -0.06, room.d / 2);
  floor.receiveShadow = true;
  floor.userData.roomId = room.id;
  g.add(floor);
  // Dollhouse cut: full walls on the north and west sides, a low rim on the south and east.
  const wall = new THREE.MeshStandardMaterial({ color: room.wallColor, roughness: 0.85 });
  const t = 0.12;
  const h = room.wallHeight;
  const low = Math.min(0.35, h);
  const wallBox = (w: number, height: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, height, d), wall);
    m.position.set(x, height / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
  };
  wallBox(room.w, h, t, room.w / 2, 0);
  wallBox(t, h, room.d, 0, room.d / 2);
  wallBox(room.w, low, t, room.w / 2, room.d);
  wallBox(t, low, room.d, room.w, room.d / 2);
  return g;
}

/**
 * Build the scene graph for a layout. Called again only when the layout itself
 * changes (structure, hires); per-frame state goes through updateScene.
 */
export function buildScene(
  layout: WorldLayout,
  world: World | null,
  departments: Department[],
  agents: Agent[],
  onRoomClick: (roomId: string) => void,
): OfficeScene {
  const root = new THREE.Group();
  const floors = new Map<number, THREE.Group>();
  const disposables: Array<{ dispose(): void }> = [];
  const floorGroup = (i: number) => {
    if (!floors.has(i)) {
      const g = new THREE.Group();
      floors.set(i, g);
      root.add(g);
    }
    return floors.get(i)!;
  };

  for (const room of layout.rooms) {
    const g = roomMesh(room);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) disposables.push(o.geometry, o.material as THREE.Material);
    });
    const { el, obj } = label("room-label", room.name);
    el.onclick = () => onRoomClick(room.id);
    el.title = "Focus this room";
    obj.position.set(room.w / 2, room.wallHeight + 0.3, 0.1);
    g.add(obj);
    floorGroup(room.floorIndex).add(g);
  }

  const roomById = new Map(layout.rooms.map((r) => [r.id, r]));
  const deptColor = (id: string) => departments.find((d) => d.id === id)?.color ?? "#8899aa";

  // Placed objects, with their behaviors.
  const animated: Animated[] = [];
  for (const [i, o] of (world?.objects ?? []).entries()) {
    const kind = world!.kinds[o.kind];
    const room = roomById.get(o.room);
    if (!kind || !room) continue;
    const obj = lookObject(kind.look, "#9aa3ad");
    obj.position.set(room.x + o.at[0], room.y, room.z + o.at[1]);
    obj.rotation.y = (o.rotationY * Math.PI) / 180;
    obj.scale.multiplyScalar(o.scale);
    if (o.label) {
      const { obj: tag } = label("object-label", o.label);
      tag.position.set(0, 1.4, 0);
      obj.add(tag);
    }
    floorGroup(room.floorIndex).add(obj);
    for (const b of kind.behaviors) {
      // Wander moves the whole object around the room; other behaviors may target one part.
      const target = b.part && b.type !== "wander" ? (obj.getObjectByName(b.part) ?? obj) : obj;
      const materials: THREE.MeshStandardMaterial[] = [];
      target.traverse((m) => {
        // Only glowing parts blink (they own their material); plain shared materials are left alone.
        const mat = m instanceof THREE.Mesh ? (m.material as THREE.MeshStandardMaterial) : null;
        if (mat?.emissive && mat.emissive.getHex() !== 0) materials.push(mat);
      });
      animated.push({
        target,
        behavior: b,
        base: { position: target.position.clone(), rotation: target.rotation.clone(), scale: target.scale.clone() },
        materials,
        room,
        seed: hash(`${o.kind}:${i}`) * 100,
      });
    }
  }

  // Agents: desk, monitor, chair, avatar, labels.
  const agentNodes = new Map<string, AgentNode>();
  const pickGeo = new THREE.BoxGeometry(1.2, 1.8, 1.4);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });
  const ringGeo = new THREE.RingGeometry(0.62, 0.72, 40);
  disposables.push(pickGeo, pickMat, ringGeo);
  for (const a of agents) {
    const seat = layout.seatOf.get(a.id);
    if (!seat || a.lifecycleState === "retired") continue;
    const room = roomById.get(seat.roomId)!;
    const g = new THREE.Group();
    g.position.set(seat.x, seat.y, seat.z);
    const d = desk();
    d.position.z = -0.35;
    const { group: mon, screen } = monitor();
    mon.position.z = -0.35;
    const c = chair();
    c.position.z = 0.35;
    g.add(d, mon, c);
    disposables.push(screen);

    const kindId = world?.avatars.byJobRole[a.jobRole] ?? world?.avatars.default;
    const kind = kindId ? world!.kinds[kindId] : undefined;
    const avatar = kind ? lookObject(kind.look, deptColor(a.departmentId)) : character("person", deptColor(a.departmentId), ["#3b2a20", "#1f2937", "#7c4a1e", "#d4a373"][Math.floor(hash(a.id) * 4)]);
    avatar.position.z = 0.3;
    g.add(avatar);

    const ringMat = new THREE.MeshBasicMaterial({ color: "#38bdf8", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    disposables.push(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.02, 0.1);
    g.add(ring);

    const pick = new THREE.Mesh(pickGeo, pickMat);
    pick.position.set(0, 0.9, 0);
    pick.userData.agentId = a.id;
    g.add(pick);

    const name = label("agent-label", "");
    name.el.innerHTML = `<b></b><small></small>`;
    name.obj.position.set(0, -0.05, 0.95);
    g.add(name.obj);
    const bubble = label("agent-bubble", "");
    bubble.obj.position.set(0.45, 1.8, 0.2);
    g.add(bubble.obj);

    floorGroup(room.floorIndex).add(g);
    agentNodes.set(a.id, { id: a.id, seat, root: g, avatar, pick, ring, screen, label: name.el, bubble: bubble.el, floorIndex: room.floorIndex });
  }

  // One sheet of paper, reused for every hand-off in flight.
  const paperMat = new THREE.MeshStandardMaterial({ color: "#ffffff", side: THREE.DoubleSide, emissive: "#ffffff", emissiveIntensity: 0.25 });
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.42), paperMat);
  paper.visible = false;
  root.add(paper);
  disposables.push(paper.geometry, paperMat);

  return {
    root,
    floors,
    agents: agentNodes,
    animated,
    paper,
    dispose() {
      root.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
      });
      root.removeFromParent();
      for (const d of disposables) d.dispose();
    },
  };
}

export interface FrameInput {
  agents: Map<string, Agent>;
  workOf: (a: Agent) => WorkState;
  needsOwner: Set<string>;
  selected: string | null;
  hover: string | null;
  flights: Flight[];
  t: number; // ms
}

/** Per-frame: agent state, behaviors, flights. Only transforms and materials change here. */
export function updateScene(s: OfficeScene, f: FrameInput) {
  const sec = f.t / 1000;
  for (const node of s.agents.values()) {
    const a = f.agents.get(node.id);
    if (!a) continue;
    const work = f.workOf(a);
    const offline = work === "offline";
    node.avatar.visible = !offline; // offline: an empty chair
    const screen = a.runtime?.state ?? "none";
    node.screen.color.set(SCREEN[screen] ?? SCREEN.unknown!);
    node.screen.emissive.set(SCREEN[screen] ?? "#000000");
    node.screen.emissiveIntensity = work === "executing" ? 0.55 + 0.35 * Math.sin(sec * 9) : screen === "running" ? 0.35 : 0.15;
    // Motion by work state: busy jitter while executing, a slow bob while thinking.
    const bob = work === "executing" ? Math.abs(Math.sin(sec * 10)) * 0.025 : work === "thinking" ? Math.sin(sec * 2.2) * 0.03 : 0;
    node.avatar.position.y = bob;
    for (const arm of ["arm-l", "arm-r"]) {
      const m = node.avatar.getObjectByName(arm);
      if (m) m.rotation.x = ((work === "executing" ? 55 + Math.sin(sec * 18 + (arm === "arm-l" ? 0 : 1.6)) * 10 : 35) * Math.PI) / 180;
    }
    const tail = node.avatar.getObjectByName("tail");
    if (tail) tail.rotation.z = Math.sin(sec * (work === "executing" ? 6 : 1.5)) * 0.4;

    const ringMat = node.ring.material as THREE.MeshBasicMaterial;
    ringMat.opacity = f.selected === node.id ? 0.95 : f.hover === node.id ? 0.45 : 0;

    const [b, small] = node.label.children as unknown as [HTMLElement, HTMLElement];
    if (b.textContent !== a.displayName) b.textContent = a.displayName;
    const role = a.acceptingWork || offline ? a.jobRole : `${a.jobRole} · paused`;
    if (small.textContent !== role) small.textContent = role;
    node.label.classList.toggle("selected", f.selected === node.id);

    let text = "";
    let tone = "";
    if (f.needsOwner.has(node.id)) [text, tone] = ["?", "review"];
    else if (work === "blocked") [text, tone] = ["!", "bad"];
    else if (work === "error") [text, tone] = ["×", "bad"];
    else if (work === "waiting") [text, tone] = ["⌛", "plain"];
    else if (work === "thinking") [text, tone] = [".".repeat(1 + (Math.floor(f.t / 400) % 3)), "plain"];
    if (node.bubble.textContent !== text) node.bubble.textContent = text;
    node.bubble.dataset.tone = tone;
    node.bubble.style.display = text ? "" : "none";
  }

  for (const an of s.animated) {
    const { target: o, behavior: b, base } = an;
    const phase = sec * b.speed * TAU + an.seed;
    switch (b.type) {
      case "spin":
        o.rotation.y = base.rotation.y + sec * b.speed * TAU * b.amount;
        break;
      case "bob":
        o.position.y = base.position.y + Math.sin(phase) * 0.08 * b.amount;
        break;
      case "sway":
        o.rotation.z = base.rotation.z + Math.sin(phase) * 0.15 * b.amount;
        break;
      case "pulse":
        o.scale.copy(base.scale).multiplyScalar(1 + Math.sin(phase) * 0.08 * b.amount);
        break;
      case "blink":
        for (const m of an.materials) m.emissiveIntensity = 0.5 + 0.5 * Math.sin(phase) * b.amount;
        break;
      case "wander": {
        // A smooth, seeded stroll around where it was placed, staying inside the room.
        const r = an.room;
        const k = sec * b.speed * 0.25;
        const x = base.position.x + (Math.sin(k + an.seed) + Math.sin(k * 0.61 + an.seed * 2)) * 0.5 * b.amount;
        const z = base.position.z + (Math.cos(k * 0.83 + an.seed) + Math.sin(k * 0.47 + an.seed * 3)) * 0.5 * b.amount;
        const nx = Math.min(r.x + r.w - 0.4, Math.max(r.x + 0.4, x));
        const nz = Math.min(r.z + r.d - 0.4, Math.max(r.z + 0.4, z));
        const dx = nx - o.position.x;
        const dz = nz - o.position.z;
        if (dx * dx + dz * dz > 1e-6) o.rotation.y = Math.atan2(-dx, -dz);
        o.position.x = nx;
        o.position.z = nz;
        break;
      }
    }
  }

  // Hand-offs: show the newest flight in progress.
  const flight = f.flights.filter((x) => f.t - x.start < 1400).at(-1);
  const from = flight && s.agents.get(flight.from);
  const to = flight && s.agents.get(flight.to);
  if (flight && from && to) {
    const k = Math.min(1, (f.t - flight.start) / 1400);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const a = from.root.position;
    const b = to.root.position;
    s.paper.visible = true;
    s.paper.position.set(a.x + (b.x - a.x) * e, a.y + (b.y - a.y) * e + 1.4 + Math.sin(Math.PI * k) * 2.2, a.z + (b.z - a.z) * e);
    s.paper.rotation.set(-0.9 + Math.sin(f.t / 140) * 0.3, Math.sin(f.t / 200) * 0.6, Math.sin(f.t / 120) * 0.25);
  } else {
    s.paper.visible = false;
  }
}
