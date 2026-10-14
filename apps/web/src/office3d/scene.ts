import type { Behavior, World } from "@agentown/core";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Agent, Department, WorkState } from "../types.ts";
import { FLOOR_HEIGHT, type PlacedRoom, type Seat, type WorldLayout } from "./layout.ts";
import { allowedRooms, inside, type Nav, reachable, route, type Spot, type Waypoint } from "./nav.ts";
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
  /** Desk, monitor and chair: stays put. */
  root: THREE.Group;
  /** The agent itself (avatar, ring, labels): sits at the desk, or walks when it may. */
  actor: THREE.Group;
  avatar: THREE.Group;
  roamer: Roamer | null;
  pick: THREE.Mesh;
  ring: THREE.Mesh;
  screen: THREE.MeshStandardMaterial;
  label: HTMLDivElement;
  bubble: HTMLDivElement;
  floorIndex: number;
}

/** Something that walks between rooms, through doors and stairs, within its access. */
interface Roamer {
  obj: THREE.Object3D;
  body: THREE.Object3D;
  allowed: Set<string>;
  room: string;
  /** Meters per second. */
  speed: number;
  path: Waypoint[] | null;
  idx: number;
  waitUntil: number;
  /** Animals are modelled sitting; walking lowers them by this much. */
  lift: number;
  /** Agents: their chair, where they sit while they work. */
  home: Spot | null;
  seated: boolean;
  seed: number;
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
  roamers: Roamer[];
  nav: Nav;
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
  // Doors are gaps in a wall.
  const wall = new THREE.MeshStandardMaterial({ color: room.wallColor, roughness: 0.85 });
  const t = 0.12;
  const h = room.wallHeight;
  const low = Math.min(0.35, h);
  const segment = (side: "north" | "south" | "east" | "west", height: number) => {
    const length = side === "north" || side === "south" ? room.w : room.d;
    const cuts = room.cuts.filter((c) => c.side === side).sort((a, b) => a.from - b.from);
    let start = 0;
    for (const [a, b] of [...cuts.map((c) => [c.from, c.to] as const), [length, length] as const]) {
      const from = Math.max(start, 0);
      const to = Math.min(a, length);
      if (to - from > 0.05) {
        const mid = (from + to) / 2;
        const along = side === "north" || side === "south";
        const m = new THREE.Mesh(new THREE.BoxGeometry(along ? to - from : t, height, along ? t : to - from), wall);
        m.position.set(along ? mid : side === "west" ? 0 : room.w, height / 2, along ? (side === "north" ? 0 : room.d) : mid);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
      }
      start = Math.max(start, b);
    }
  };
  segment("north", h);
  segment("west", h);
  segment("south", low);
  segment("east", low);
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
  nav: Nav,
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

  // Thresholds between doors, and stairs or elevators between floors.
  const threshold = new THREE.MeshStandardMaterial({ color: "#a08c74", roughness: 0.9 });
  const step = new THREE.MeshStandardMaterial({ color: "#8a7a68", roughness: 0.8 });
  disposables.push(threshold, step);
  const floorOfY = (y: number) => Math.round(y / FLOOR_HEIGHT);
  for (const d of layout.doors) {
    const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]) + 0.3;
    const m = new THREE.Mesh(new THREE.BoxGeometry(d.width, 0.1, len), threshold);
    m.position.set((d.a[0] + d.b[0]) / 2, d.y - 0.05, (d.a[1] + d.b[1]) / 2);
    m.rotation.y = Math.atan2(d.b[0] - d.a[0], d.b[1] - d.a[1]);
    m.receiveShadow = true;
    disposables.push(m.geometry);
    floorGroup(floorOfY(d.y)).add(m);
  }
  for (const l of layout.links) {
    const up = l.to[1] >= l.from[1];
    const [bottom, top] = up ? [l.from, l.to] : [l.to, l.from];
    // A short flight of steps at the bottom, a hatch at the top.
    const flight = new THREE.Group();
    for (let i = 0; i < 6; i++) {
      const box = new THREE.Mesh(new THREE.BoxGeometry(1, 0.22 * (i + 1), 0.3), step);
      box.position.set(0, 0.11 * (i + 1), -0.75 + i * 0.3);
      box.castShadow = true;
      disposables.push(box.geometry);
      flight.add(box);
    }
    flight.position.set(...bottom);
    floorGroup(floorOfY(bottom[1])).add(flight);
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.06, 1.2), step);
    hatch.position.set(top[0], top[1] + 0.03, top[2]);
    disposables.push(hatch.geometry);
    floorGroup(floorOfY(top[1])).add(hatch);
    const tag = label("object-label", l.kind === "elevator" ? "Elevator" : "Stairs");
    tag.obj.position.set(bottom[0], bottom[1] + 1.8, bottom[2]);
    floorGroup(floorOfY(bottom[1])).add(tag.obj);
  }

  const roomById = new Map(layout.rooms.map((r) => [r.id, r]));
  const deptColor = (id: string) => departments.find((d) => d.id === id)?.color ?? "#8899aa";

  const roamers: Roamer[] = [];
  const lifted = (o: THREE.Object3D) => ((o.userData.lift as number | undefined) ?? 0) * o.scale.y;

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
    const roam = kind.behaviors.find((b) => b.type === "roam");
    if (roam) {
      // Roamers live in world space: they change rooms and floors.
      const body = new THREE.Group();
      body.position.copy(obj.position);
      body.rotation.y = obj.rotation.y;
      obj.position.set(0, 0, 0);
      obj.rotation.y = 0;
      if (o.label) {
        const tag = obj.children.find((c) => c instanceof CSS2DObject);
        if (tag) body.add(tag);
      }
      body.add(obj);
      root.add(body);
      roamers.push({
        obj: body,
        body: obj,
        allowed: allowedRooms(kind.access, room.id, null, world, layout),
        room: room.id,
        speed: 1.2 * roam.amount * roam.speed,
        path: null,
        idx: 0,
        waitUntil: 0,
        lift: lifted(obj),
        home: null,
        seated: false,
        seed: hash(`${o.kind}:${i}`),
      });
    } else {
      floorGroup(room.floorIndex).add(obj);
    }
    for (const b of kind.behaviors.filter((x) => x.type !== "roam")) {
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
    // The agent stands in world space so it can leave its desk; seated, it is at its chair.
    const actor = new THREE.Group();
    actor.position.set(seat.x, seat.y, seat.z + 0.3);
    actor.add(avatar);
    root.add(actor);
    const roam = kind?.behaviors.find((b) => b.type === "roam");
    const roamer: Roamer | null = roam
      ? {
          obj: actor,
          body: avatar,
          allowed: allowedRooms(kind!.access, seat.roomId, a.departmentId, world, layout),
          room: seat.roomId,
          speed: 1.2 * roam.amount * roam.speed,
          path: null,
          idx: 0,
          waitUntil: 0,
          lift: lifted(avatar),
          home: { room: seat.roomId, x: seat.x, z: seat.z + 0.3 },
          seated: true,
          seed: hash(a.id),
        }
      : null;

    const ringMat = new THREE.MeshBasicMaterial({ color: "#38bdf8", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    disposables.push(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.02, -0.2);
    actor.add(ring);

    const pick = new THREE.Mesh(pickGeo, pickMat);
    pick.position.set(0, 0.9, -0.3);
    pick.userData.agentId = a.id;
    actor.add(pick);

    const name = label("agent-label", "");
    name.el.innerHTML = `<b></b><small></small>`;
    name.obj.position.set(0, -0.05, 0.65);
    actor.add(name.obj);
    const bubble = label("agent-bubble", "");
    bubble.obj.position.set(0.45, 1.8, -0.1);
    actor.add(bubble.obj);

    floorGroup(room.floorIndex).add(g);
    if (roamer) roamers.push(roamer);
    agentNodes.set(a.id, { id: a.id, seat, root: g, actor, avatar, roamer, pick, ring, screen, label: name.el, bubble: bubble.el, floorIndex: room.floorIndex });
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
    roamers,
    nav,
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
  /** Seconds since the previous frame. */
  dt: number;
}

/** Per-frame: agent state, behaviors, flights. Only transforms and materials change here. */
export function updateScene(s: OfficeScene, f: FrameInput) {
  const sec = f.t / 1000;
  for (const node of s.agents.values()) {
    const a = f.agents.get(node.id);
    if (!a) continue;
    const work = f.workOf(a);
    const offline = work === "offline";
    // Idle agents with a roaming avatar take a walk; any work brings them back to their chair.
    if (node.roamer) {
      if (offline) seat(node.roamer);
      else stepRoamer(s.nav, node.roamer, f.t, f.dt, work !== "idle");
    }
    const floorShown = s.floors.get(Math.round(node.actor.position.y / FLOOR_HEIGHT))?.visible ?? true;
    node.actor.visible = !offline && floorShown; // offline: an empty chair
    const screen = a.runtime?.state ?? "none";
    node.screen.color.set(SCREEN[screen] ?? SCREEN.unknown!);
    node.screen.emissive.set(SCREEN[screen] ?? "#000000");
    node.screen.emissiveIntensity = work === "executing" ? 0.55 + 0.35 * Math.sin(sec * 9) : screen === "running" ? 0.35 : 0.15;
    // Motion by work state: busy jitter while executing, a slow bob while thinking.
    const bob = work === "executing" ? Math.abs(Math.sin(sec * 10)) * 0.025 : work === "thinking" ? Math.sin(sec * 2.2) * 0.03 : 0;
    node.avatar.position.y = (node.roamer && !node.roamer.seated ? -node.roamer.lift : 0) + bob;
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

  for (const r of s.roamers) {
    if (r.home) continue; // agents were stepped above
    stepRoamer(s.nav, r, f.t, f.dt, false);
    r.body.position.y = -r.lift;
    r.obj.visible = s.floors.get(Math.round(r.obj.position.y / FLOOR_HEIGHT))?.visible ?? true;
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

/** Put an agent straight back in its chair (it went offline, or there is no way back). */
function seat(r: Roamer) {
  if (!r.home) return;
  r.obj.position.set(r.home.x, r.obj.position.y, r.home.z);
  r.obj.position.y = Math.round(r.obj.position.y / FLOOR_HEIGHT) * FLOOR_HEIGHT;
  r.room = r.home.room;
  r.obj.rotation.y = 0;
  r.path = null;
  r.seated = true;
  swingLegs(r.body, 0);
}

function swingLegs(body: THREE.Object3D, angle: number) {
  const l = body.getObjectByName("leg-l");
  const rr = body.getObjectByName("leg-r");
  if (l) l.rotation.x = angle;
  if (rr) rr.rotation.x = -angle;
}

/**
 * One frame of walking. Agents that should work head for their chair and sit;
 * everything else rests a while, then picks a room it may enter and walks there.
 */
function stepRoamer(nav: Nav, r: Roamer, now: number, dt: number, goHome: boolean) {
  const here: Spot = { room: r.room, x: r.obj.position.x, z: r.obj.position.z };
  if (goHome && r.home) {
    if (r.seated) return;
    const last = r.path?.at(-1);
    if (!last || last.x !== r.home.x || last.z !== r.home.z) {
      r.path = route(nav, here, r.home, r.allowed);
      r.idx = 0;
      if (!r.path) return seat(r);
    }
  } else {
    if (r.seated) {
      // Stand up after a moment of idling.
      if (!r.waitUntil) r.waitUntil = now + 2000 + r.seed * 6000;
      if (now < r.waitUntil) return;
      r.seated = false;
      r.waitUntil = 0;
    }
    if (!r.path && now >= r.waitUntil) {
      const options = reachable(nav, r.room, r.allowed);
      const room = nav.rooms.get(options[Math.floor(Math.random() * options.length)]!)!;
      const [x, z] = inside(room, room.x + Math.random() * room.w, room.z + Math.random() * room.d);
      r.path = route(nav, here, { room: room.id, x, z }, r.allowed);
      r.idx = 0;
      if (!r.path) r.waitUntil = now + 3000;
    }
  }
  const wp = r.path?.[r.idx];
  if (!wp) {
    swingLegs(r.body, 0);
    return;
  }
  if (wp.jump) {
    r.obj.position.set(wp.x, wp.y, wp.z);
  } else {
    const dx = wp.x - r.obj.position.x;
    const dz = wp.z - r.obj.position.z;
    const dist = Math.hypot(dx, dz);
    const stepLen = r.speed * Math.min(dt, 0.1);
    if (dist > stepLen) {
      r.obj.position.x += (dx / dist) * stepLen;
      r.obj.position.z += (dz / dist) * stepLen;
      r.obj.position.y = wp.y;
      r.obj.rotation.y = Math.atan2(-dx, -dz);
      swingLegs(r.body, Math.sin(now / 110) * 0.5);
      return;
    }
    r.obj.position.set(wp.x, wp.y, wp.z);
  }
  r.room = wp.room;
  r.idx++;
  if (r.idx >= r.path!.length) {
    r.path = null;
    swingLegs(r.body, 0);
    if (goHome && r.home) {
      r.seated = true;
      r.obj.rotation.y = 0;
    } else {
      r.waitUntil = now + 1500 + Math.random() * 4000;
    }
  }
}
