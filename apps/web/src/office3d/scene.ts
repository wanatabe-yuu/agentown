import type { Behavior, World } from "@agentown/core/world";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Agent, Department, WorkState } from "../types.ts";
import { FLOOR_HEIGHT, type PlacedRoom, type Seat, type WorldLayout } from "./layout.ts";
import { t } from "../i18n.ts";
import { allowedRooms, freeSpot, inside, type Nav, reachable, route, type Spot, type Waypoint } from "./nav.ts";
import { loadModels, texture } from "./assets.ts";
import { chair, character, desk, lookObject, monitor } from "./procedural.ts";
import { type Animated, applyBehavior, prepareBehaviors } from "./behave.ts";
import { pattern } from "./patterns.ts";

/** A task handed from one agent to another: a sheet of paper flies between their desks. */
export interface Flight {
  from: string;
  to: string;
  start: number;
  label: string;
}

export const SCREEN: Record<string, string> = {
  running: "#4ade80",
  pending: "#facc15",
  restarting: "#fb923c",
  failed: "#ef4444",
  stopped: "#475569",
  none: "#334155",
  unknown: "#a78bfa",
};

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


export interface OfficeScene {
  root: THREE.Group;
  floors: Map<number, THREE.Group>;
  agents: Map<string, AgentNode>;
  animated: Animated[];
  roamers: Roamer[];
  nav: Nav;
  /** Animations that came with uploaded models. */
  mixers: THREE.AnimationMixer[];
  paper: THREE.Mesh;
  dispose(): void;
}

/**
 * How an agent looks: its own override, else its job's character, else the
 * world's default, else a person in its department's color.
 */
export function agentAvatar(a: Pick<Agent, "id" | "jobRole">, world: World | null | undefined, deptColor: string): { avatar: THREE.Group; kind: World["kinds"][string] | undefined } {
  const own = world?.avatars.byAgent?.[a.id];
  const kindId = own?.kind ?? world?.avatars.byJobRole[a.jobRole] ?? world?.avatars.default;
  const kind = kindId ? world!.kinds[kindId] : undefined;
  const hairs = ["#3b2a20", "#1f2937", "#7c4a1e", "#d4a373"];
  // The same job looks alike, but each person keeps their own face and hair.
  const variant = Math.floor(hash(a.id) * 16);
  const done = (avatar: THREE.Group) => {
    avatar.userData.seed = hash(a.id);
    return { avatar, kind };
  };
  if (own?.character) return done(character(own.character, own.color ?? deptColor, own.accent ?? hairs[variant % 4], 1, variant));
  if (kind && "character" in kind.look) return done(lookObject({ ...kind.look, ...(own?.color ? { color: own.color } : {}), ...(own?.accent ? { accent: own.accent } : {}) }, deptColor, variant));
  if (kind) return done(lookObject(kind.look, deptColor));
  return done(character("person", own?.color ?? deptColor, own?.accent ?? hairs[variant % 4], 1, variant));
}

/**
 * Motion by work state, on the named joints characters have (head, arms,
 * legs, tail, eyes, antenna): breathing and looking around when idle, typing
 * while working, a hand to the chin while thinking, drumming fingers while
 * waiting, a hung head when blocked. Characters without a joint just skip it.
 */
export function animateAvatar(avatar: THREE.Object3D, work: string, sec: number, baseY = 0, walking = false) {
  const seed = ((avatar.userData.seed as number | undefined) ?? 0) * 10;
  const t = sec + seed;
  const get = (n: string) => avatar.getObjectByName(n);
  const head = get("head");
  const armL = get("arm-l");
  const armR = get("arm-r");
  const tail = get("tail");
  const eyes = get("eyes");
  const deg = Math.PI / 180;
  let bob = Math.sin(t * 1.6) * 0.006; // breathing
  let headX = 0;
  let headY = Math.sin(t * 0.35) * 0.35 * Math.max(0, Math.sin(t * 0.13)); // now and then a look around
  let headZ = 0;
  let armLX = 35;
  let armRX = 35;
  let armRZ = 0;
  if (walking) {
    armLX = Math.sin(t * 9) * 28;
    armRX = -Math.sin(t * 9) * 28;
    headY = 0;
    bob = Math.abs(Math.sin(t * 9)) * 0.03;
  } else if (work === "executing") {
    armLX = 58 + Math.sin(t * 18) * 9;
    armRX = 58 + Math.sin(t * 18 + 1.6) * 9;
    headX = 8 * deg + Math.sin(t * 2) * 0.03;
    headY = Math.sin(t * 0.9) * 0.08;
    bob = Math.abs(Math.sin(t * 10)) * 0.012;
  } else if (work === "thinking") {
    // A hand to the chin.
    armRX = 145;
    armRZ = -24;
    headZ = 0.18;
    headX = -6 * deg;
    headY = Math.sin(t * 0.5) * 0.25;
    bob = Math.sin(t * 2.2) * 0.02;
  } else if (work === "waiting") {
    armLX = 50 + Math.max(0, Math.sin(t * 7)) * 8;
    headY = Math.sin(t * 0.8) * 0.5;
  } else if (work === "blocked" || work === "error") {
    headX = 22 * deg;
    armLX = 15;
    armRX = 15;
    bob = Math.sin(t * 0.9) * 0.01 - 0.02;
  }
  avatar.position.y = baseY + bob;
  if (head) head.rotation.set(headX, headY, headZ);
  if (armL) armL.rotation.set(armLX * deg, 0, 0);
  if (armR) armR.rotation.set(armRX * deg, 0, armRZ * deg);
  // Blink every few seconds.
  if (eyes) eyes.scale.y = (t * 0.7) % 4 < 0.12 ? 0.1 : 1;
  if (tail) tail.rotation.z = Math.sin(t * (work === "executing" || walking ? 7 : 1.6)) * (work === "blocked" ? 0.1 : 0.45);
  const tip = get("antenna-tip") as THREE.Mesh | undefined;
  if (tip) (tip.material as THREE.MeshStandardMaterial).emissiveIntensity = work === "executing" ? 0.5 + 0.5 * Math.sin(t * 12) : 0.4 + 0.3 * Math.sin(t * 2);
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
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(room.w, 0.12, room.d),
    new THREE.MeshStandardMaterial(
      room.floorTexture
        ? { map: texture(room.floorTexture, room.w, room.d, room.textureRepeat), roughness: 0.9 }
        : { color: room.floorStyle && room.floorStyle !== "plain" ? "#ffffff" : room.floorColor, map: pattern(room.floorStyle, room.floorColor, room.w, room.d), roughness: room.floorStyle === "tile" || room.floorStyle === "checker" ? 0.45 : 0.85 },
    ),
  );
  floor.position.set(room.w / 2, -0.06, room.d / 2);
  floor.receiveShadow = true;
  floor.userData.roomId = room.id;
  g.add(floor);
  // Dollhouse cut: full walls on the north and west sides, a low rim on the south and east.
  // Doors are gaps in a wall.
  const plainWall = new THREE.MeshStandardMaterial(
    room.wallTexture ? { map: texture(room.wallTexture, Math.max(room.w, room.d), room.wallHeight, room.textureRepeat), roughness: 0.85 } : { color: room.wallColor, roughness: 0.85 },
  );
  // A patterned wall gets its own texture per segment, so bricks keep their size.
  const wallFor = (length: number, height: number) =>
    room.wallTexture || !room.wallStyle || room.wallStyle === "plain"
      ? plainWall
      : new THREE.MeshStandardMaterial({ color: "#ffffff", map: pattern(room.wallStyle, room.wallColor, length, height), roughness: 0.85 });
  const trim = new THREE.MeshStandardMaterial({ color: new THREE.Color(room.wallColor).lerp(new THREE.Color("#000000"), 0.35), roughness: 0.6 });
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
        const m = new THREE.Mesh(new THREE.BoxGeometry(along ? to - from : t, height, along ? t : to - from), wallFor(to - from, height));
        m.position.set(along ? mid : side === "west" ? 0 : room.w, height / 2, along ? (side === "north" ? 0 : room.d) : mid);
        m.castShadow = true;
        m.receiveShadow = true;
        g.add(m);
        // A skirting board along the inside of tall walls; a cap on the low rims.
        const sk = new THREE.Mesh(new THREE.BoxGeometry(along ? to - from : t + 0.04, height > 1 ? 0.12 : 0.04, along ? t + 0.04 : to - from), trim);
        sk.position.set(m.position.x, height > 1 ? 0.06 : height + 0.02, m.position.z);
        g.add(sk);
      }
      start = Math.max(start, b);
    }
  };
  const half = Math.min(h, 1.1);
  segment("north", room.shared.north ? half : h);
  segment("west", room.shared.west ? half : h);
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
      if (o instanceof THREE.Mesh) {
        const mat = o.material as THREE.MeshStandardMaterial;
        disposables.push(o.geometry, mat);
        if (mat.map) disposables.push(mat.map);
      }
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
    const tag = label("object-label", l.kind === "elevator" ? t("Elevator") : t("Stairs"));
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
    // The world editor finds placed objects by this index.
    obj.userData.objectIndex = i;
    obj.scale.multiplyScalar(o.scale);
    const title = o.title ?? kind.title;
    if (o.label || title) {
      const { el, obj: tag } = label("object-label", "");
      if (o.label) el.append(Object.assign(document.createElement("b"), { textContent: o.label }));
      if (title) el.append(Object.assign(document.createElement("small"), { textContent: title }));
      tag.position.set(0, 1.4, 0);
      obj.add(tag);
    }
    const roam = kind.behaviors.find((b) => b.type === "roam");
    if (roam) {
      // Roamers live in world space: they change rooms and floors.
      const body = new THREE.Group();
      body.userData.objectIndex = i;
      delete obj.userData.objectIndex;
      body.position.copy(obj.position);
      body.rotation.y = obj.rotation.y;
      obj.position.set(0, 0, 0);
      obj.rotation.y = 0;
      if (o.label || title) {
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
    animated.push(...prepareBehaviors(obj, kind, hash(`${o.kind}:${i}`) * 100, room));
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

    const { avatar, kind } = agentAvatar(a, world, deptColor(a.departmentId));
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

  const mixers: THREE.AnimationMixer[] = [];
  let alive = true;
  loadModels(root, mixers, () => alive);

  return {
    root,
    floors,
    agents: agentNodes,
    animated,
    roamers,
    nav,
    mixers,
    paper,
    dispose() {
      alive = false;
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
  /** World editor open: everything holds still where it was placed. */
  frozen?: boolean;
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
      if (offline || f.frozen) seat(node.roamer);
      else stepRoamer(s.nav, node.roamer, f.t, f.dt, work !== "idle");
    }
    const floorShown = s.floors.get(Math.round(node.actor.position.y / FLOOR_HEIGHT))?.visible ?? true;
    node.actor.visible = !offline && floorShown; // offline: an empty chair
    const screen = a.runtime?.state ?? "none";
    node.screen.color.set(SCREEN[screen] ?? SCREEN.unknown!);
    node.screen.emissive.set(SCREEN[screen] ?? "#000000");
    node.screen.emissiveIntensity = work === "executing" ? 0.55 + 0.35 * Math.sin(sec * 9) : screen === "running" ? 0.35 : 0.15;
    const walking = !!node.roamer && !node.roamer.seated && !!node.roamer.path;
    animateAvatar(node.avatar, work, sec, node.roamer && !node.roamer.seated ? -node.roamer.lift : 0, walking);

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

  for (const an of f.frozen ? [] : s.animated) applyBehavior(an, sec);

  for (const r of s.roamers) {
    if (r.home) continue; // agents were stepped above
    if (!f.frozen) stepRoamer(s.nav, r, f.t, f.dt, false);
    // Animals and people that roam breathe, look around, wag and swing their arms like agents do.
    animateAvatar(r.body, "idle", sec, -r.lift, !!r.path);
    r.obj.visible = s.floors.get(Math.round(r.obj.position.y / FLOOR_HEIGHT))?.visible ?? true;
  }

  if (!f.frozen) for (const m of s.mixers) m.update(Math.min(f.dt, 0.1));

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

/** Turn smoothly the short way round, instead of snapping. */
function turnToward(o: THREE.Object3D, angle: number, dt: number) {
  let d = angle - o.rotation.y;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  o.rotation.y += d * Math.min(1, dt * 8);
}

export function swingLegs(body: THREE.Object3D, angle: number) {
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
      const [x, z] = freeSpot(nav, room.id, ...inside(room, room.x + Math.random() * room.w, room.z + Math.random() * room.d));
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
  {
    // Stairs and elevators are climbed too (slower), not jumped.
    const dx = wp.x - r.obj.position.x;
    const dy = wp.y - r.obj.position.y;
    const dz = wp.z - r.obj.position.z;
    const flat = Math.hypot(dx, dz);
    const dist = Math.hypot(flat, dy);
    const stepLen = r.speed * (wp.jump ? 0.6 : 1) * Math.min(dt, 0.1);
    if (dist > stepLen) {
      r.obj.position.x += (dx / dist) * stepLen;
      r.obj.position.y += (dy / dist) * stepLen;
      r.obj.position.z += (dz / dist) * stepLen;
      if (flat > 0.02) turnToward(r.obj, Math.atan2(-dx, -dz), dt);
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

/** The placed object (index into world.objects) under a hit mesh, if any. */
export function objectIndexOf(o: THREE.Object3D | null): number | null {
  for (let x = o; x; x = x.parent) if (typeof x.userData.objectIndex === "number") return x.userData.objectIndex as number;
  return null;
}
