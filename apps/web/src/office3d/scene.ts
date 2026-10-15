import { canTalk, objectState, type World } from "@agentown/core/world";
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import type { Agent, Department, ObjectActivity, WorkState } from "../types.ts";
import { FLOOR_HEIGHT, type PlacedRoom, type Seat, type WorldLayout } from "./layout.ts";
import { t } from "../i18n.ts";
import { allowedRooms, type Nav } from "./nav.ts";
import { errandSpot, type Roamer, seat, sitLegs, stepErrand, stepRoamer, swingLegs } from "./walk.ts";

export { sitLegs, swingLegs } from "./walk.ts";
import { loadModels, texture } from "./assets.ts";
import { orgPath } from "../api.ts";
import { chair, character, desk, lookObject, monitor, setToon, surface } from "./procedural.ts";
import { ObjectLife } from "./behave.ts";
import { ScriptHost } from "./scripts.ts";
import { pattern } from "./patterns.ts";
import { type DeskState, deskStates } from "./live.ts";
// ?debug: what each workstation shows, readable from the console.
if (typeof location !== "undefined" && new URLSearchParams(location.search).has("debug")) (globalThis as unknown as { deskStates: unknown }).deskStates = deskStates;
import { agentPortrait, lookPortrait } from "./portrait.ts";

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

export interface AgentNode {
  id: string;
  seat: Seat;
  /** Its workstation (desk, computer, chair): a thing of its own that stays put. */
  root: THREE.Group;
  /** The agent itself (avatar, ring, labels): sits at the desk, or walks when it may. */
  actor: THREE.Group;
  avatar: THREE.Group;
  roamer: Roamer;
  pick: THREE.Mesh;
  ring: THREE.Mesh;
  screen: THREE.MeshStandardMaterial;
  label: HTMLDivElement;
  bubble: HTMLDivElement;
  floorIndex: number;
  /** Seen from above (2D): their picture instead of their body, and a small screen for their desk. */
  badge: THREE.Sprite;
  deskBadge: THREE.Sprite;
}

/** A placed object, living through its states. */
export interface PlacedLife {
  id: string;
  kindId: string;
  life: ObjectLife;
  /** Where it is placed (a roamer tracks its current room itself). */
  roomId: string;
  /** What carries it in world space. */
  root: THREE.Object3D;
  roamer: Roamer | null;
  /** Its picture, seen from above (2D). */
  badge: THREE.Sprite;
}

export type { DeskState } from "./live.ts";


export interface OfficeScene {
  root: THREE.Group;
  floors: Map<number, THREE.Group>;
  agents: Map<string, AgentNode>;
  lives: PlacedLife[];
  roamers: Roamer[];
  /** Object actions already turned into errands. */
  errands: Set<string>;
  nav: Nav;
  /** Animations that came with uploaded models. */
  mixers: THREE.AnimationMixer[];
  paper: THREE.Mesh;
  /** Object scripts, when any kind has one. */
  scripts: ScriptHost | null;
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
  } else if (work === "sleep") {
    // Curled up: head down, slow deep breaths.
    headX = 32 * deg;
    headY = 0;
    armLX = 8;
    armRX = 8;
    bob = Math.sin(t * 0.9) * 0.012 - 0.04;
  } else if (work === "happy") {
    bob = Math.abs(Math.sin(t * 5)) * 0.035;
    headZ = Math.sin(t * 3) * 0.18;
    headY = 0;
    armLX = 40 + Math.sin(t * 5) * 10;
    armRX = 40 - Math.sin(t * 5) * 10;
  } else if (work === "play") {
    bob = Math.abs(Math.sin(t * 7)) * 0.09;
    armLX = 120 + Math.sin(t * 7) * 30;
    armRX = 120 - Math.sin(t * 7) * 30;
    headY = Math.sin(t * 3.5) * 0.3;
  } else if (work === "pet") {
    // Bent down, a hand stroking something in front.
    bob = -0.16;
    headX = 26 * deg;
    headY = 0;
    armLX = 55;
    armRX = 72 + Math.sin(t * 4) * 14;
  } else if (work === "use") {
    headX = 12 * deg;
    headY = Math.sin(t * 0.7) * 0.06;
    armLX = 30;
    armRX = 78 + Math.sin(t * 6) * 6;
  }
  avatar.position.y = baseY + bob;
  if (head) head.rotation.set(headX, headY, headZ);
  if (armL) armL.rotation.set(armLX * deg, 0, 0);
  if (armR) armR.rotation.set(armRX * deg, 0, armRZ * deg);
  // Blink every few seconds.
  if (eyes) eyes.scale.y = work === "sleep" ? 0.1 : work === "happy" ? 0.55 : (t * 0.7) % 4 < 0.12 ? 0.1 : 1;
  if (tail) tail.rotation.z = Math.sin(t * (work === "happy" || work === "play" ? 12 : work === "executing" || walking ? 7 : work === "sleep" ? 0.6 : 1.6)) * (work === "blocked" ? 0.1 : work === "sleep" ? 0.15 : 0.45);
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
    surface(
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
  const plainWall = surface(
    room.wallTexture ? { map: texture(room.wallTexture, Math.max(room.w, room.d), room.wallHeight, room.textureRepeat), roughness: 0.85 } : { color: room.wallColor, roughness: 0.85 },
  );
  // A patterned wall gets its own texture per segment, so bricks keep their size.
  const wallFor = (length: number, height: number) =>
    room.wallTexture || !room.wallStyle || room.wallStyle === "plain"
      ? plainWall
      : surface({ color: "#ffffff", map: pattern(room.wallStyle, room.wallColor, length, height), roughness: 0.85 });
  const trim = surface({ color: new THREE.Color(room.wallColor).lerp(new THREE.Color("#000000"), 0.35), roughness: 0.6 });
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

/** Seen from above, everything is a round picture floating over where it is. */
const BADGE_Y = 3.2;
function badge(color: string, size: number, picture: Promise<string> | string | null, disposables: Array<{ dispose(): void }>, image?: string | null, ring = "#ffffff"): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(size);
  sprite.position.y = BADGE_Y;
  sprite.renderOrder = 10;
  sprite.visible = false;
  disposables.push(tex, mat);
  const draw = (img: HTMLImageElement | null) => {
    g.clearRect(0, 0, 128, 128);
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.fillStyle = color;
    g.fill();
    if (img) {
      g.save();
      g.beginPath();
      g.arc(64, 64, 54, 0, Math.PI * 2);
      g.clip();
      g.fillStyle = "#fbf7f0";
      g.fillRect(0, 0, 128, 128);
      // Portraits leave a margin around the model: crop in a little.
      const k = image ? 0 : 10;
      g.drawImage(img, 10 - k, 10 - k, 108 + 2 * k, 108 + 2 * k);
      g.restore();
    }
    g.lineWidth = 7;
    g.strokeStyle = ring;
    g.beginPath();
    g.arc(64, 64, 60, 0, Math.PI * 2);
    g.stroke();
    tex.needsUpdate = true;
  };
  draw(null);
  const load = (url: string) => {
    if (!url) return;
    const img = new Image();
    img.onload = () => draw(img);
    img.src = url;
  };
  if (image) load(image);
  else if (typeof picture === "string") load(picture);
  else picture?.then(load).catch(() => {});
  return sprite;
}

/** A desk seen from above: a small screen glyph, tinted by the computer's state each frame. */
function deskBadge(disposables: Array<{ dispose(): void }>): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  g.fillStyle = "#ffffff";
  g.beginPath();
  g.roundRect(6, 10, 52, 36, 7);
  g.fill();
  g.fillRect(26, 46, 12, 8);
  g.fillRect(18, 52, 28, 5);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.setScalar(0.55);
  sprite.position.set(0, BADGE_Y - 0.1, -0.55);
  sprite.renderOrder = 9;
  sprite.visible = false;
  disposables.push(tex, mat);
  return sprite;
}

const assetUrl = (id: string) => orgPath(`/api/assets/${encodeURIComponent(id)}`);

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
  /** The scene this one replaces: whoever was walking keeps walking from where they were. */
  previous?: OfficeScene | null,
): OfficeScene {
  setToon(world?.style === "anime");
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
  const threshold = surface({ color: "#a08c74", roughness: 0.9 });
  const step = surface({ color: "#8a7a68", roughness: 0.8 });
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
  const canTalkHere = (o: World["objects"][number]) => !!world && canTalk(world, o);
  const lifted = (o: THREE.Object3D) => ((o.userData.lift as number | undefined) ?? 0) * o.scale.y;

  // Placed objects, living through their states.
  const lives: PlacedLife[] = [];
  for (const [i, o] of (world?.objects ?? []).entries()) {
    const kind = world!.kinds[o.kind];
    const room = roomById.get(o.room);
    if (!kind || !room) continue;
    const obj = lookObject(kind.look, "#9aa3ad");
    obj.position.set(room.x + o.at[0], room.y, room.z + o.at[1]);
    obj.rotation.y = (o.rotationY * Math.PI) / 180;
    // The world editor finds placed objects by this index.
    obj.userData.objectIndex = i;
    obj.userData.character = "character" in kind.look;
    obj.scale.multiplyScalar(o.scale);
    const title = o.title ?? kind.title;
    if (o.label || title) {
      const { el, obj: tag } = label("object-label", "");
      if (o.label) el.append(Object.assign(document.createElement("b"), { textContent: o.label }));
      if (title) el.append(Object.assign(document.createElement("small"), { textContent: title }));
      tag.position.set(0, 1.4, 0);
      obj.add(tag);
    }
    const seed = hash(`${o.kind}:${i}`);
    const walks = [kind.behaviors, ...kind.states.map((x) => x.behaviors ?? [])].some((bs) => bs.some((b) => b.type === "roam"));
    const roam = [...kind.behaviors, ...kind.states.flatMap((x) => x.behaviors ?? [])].find((b) => b.type === "roam");
    let roamer: Roamer | null = null;
    let carrier: THREE.Object3D = obj;
    if (walks && roam) {
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
      carrier = body;
      roamer = {
        key: `object:${o.id ?? i}`,
        lost: 0,
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
        seed,
        wanders: true,
        errand: null,
      };
      roamers.push(roamer);
    } else {
      floorGroup(room.floorIndex).add(obj);
    }
    // Bigger things get bigger pictures on the map, within reason.
    const footprint = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
    const ring = kind.category === "character" || canTalkHere(o) ? "#e0a86a" : kind.actions.length ? "#9fd3c7" : "#ffffff";
    const pic = badge("#fbf7f0", Math.min(1.25, Math.max(0.7, Math.max(footprint.x, footprint.z) * 0.6)), lookPortrait(kind.look), disposables, o.image ? assetUrl(o.image) : null, ring);
    pic.scale.divideScalar(carrier === obj ? o.scale : 1);
    pic.position.y = BADGE_Y / (carrier === obj ? o.scale : 1);
    carrier.add(pic);
    lives.push({ id: o.id ?? `#${i}`, kindId: o.kind, life: new ObjectLife(obj, kind, seed * 100, room), roomId: room.id, root: carrier, roamer, badge: pic });
  }

  // Agents: desk, monitor, chair, avatar, labels.
  const agentNodes = new Map<string, AgentNode>();
  // Just the person: the desk in front of them is its own thing.
  const pickGeo = new THREE.BoxGeometry(0.75, 1.7, 0.75);
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
    // Picking the desk opens the workstation, not the person.
    g.userData.workstation = a.id;
    disposables.push(screen);

    const { avatar, kind } = agentAvatar(a, world, deptColor(a.departmentId));
    // The agent stands in world space so it can leave its desk; seated, it is at its chair.
    const actor = new THREE.Group();
    actor.position.set(seat.x, seat.y, seat.z + 0.3);
    actor.add(avatar);
    root.add(actor);
    // Everyone can walk (to pet the cat, to use the espresso machine); only roaming looks stroll about when idle.
    const roam = kind?.behaviors.find((b) => b.type === "roam");
    const roamer: Roamer = {
      key: `agent:${a.id}`,
      lost: 0,
      obj: actor,
      body: avatar,
      allowed: allowedRooms(kind?.access ?? "own-room", seat.roomId, a.departmentId, world, layout),
      room: seat.roomId,
      speed: roam ? 1.2 * roam.amount * roam.speed : 1.2,
      path: null,
      idx: 0,
      waitUntil: 0,
      lift: lifted(avatar),
      home: { room: seat.roomId, x: seat.x, z: seat.z + 0.3 },
      seated: true,
      seed: hash(a.id),
      wanders: !!roam,
      errand: null,
    };

    sitLegs(avatar);
    const ringMat = new THREE.MeshBasicMaterial({ color: "#38bdf8", transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
    disposables.push(ringMat);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, 0.02, -0.2);
    actor.add(ring);

    const pick = new THREE.Mesh(pickGeo, pickMat);
    pick.position.set(0, 0.85, 0);
    pick.userData.agentId = a.id;
    actor.add(pick);

    const name = label("agent-label", "");
    name.el.innerHTML = `<b></b><small></small>`;
    name.obj.position.set(0, -0.05, 0.65);
    actor.add(name.obj);
    const bubble = label("agent-bubble", "");
    bubble.el.dataset.agent = a.id;
    bubble.obj.position.set(0.45, 1.8, -0.1);
    actor.add(bubble.obj);

    floorGroup(room.floorIndex).add(g);
    roamers.push(roamer);
    const own = world?.avatars.byAgent?.[a.id]?.image;
    const face = badge(deptColor(a.departmentId), 1.3, own ? null : agentPortrait(a, world, deptColor(a.departmentId)), disposables, own ? assetUrl(own) : null);
    face.renderOrder = 11;
    actor.add(face);
    const screenBadge = deskBadge(disposables);
    g.add(screenBadge);
    agentNodes.set(a.id, { id: a.id, seat, root: g, actor, avatar, roamer, pick, ring, screen, label: name.el, bubble: bubble.el, floorIndex: room.floorIndex, badge: face, deskBadge: screenBadge });
  }

  // One sheet of paper, reused for every hand-off in flight.
  const paperMat = new THREE.MeshStandardMaterial({ color: "#ffffff", side: THREE.DoubleSide, emissive: "#ffffff", emissiveIntensity: 0.25 });
  const paper = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.42), paperMat);
  paper.visible = false;
  root.add(paper);
  disposables.push(paper.geometry, paperMat);

  // Carry over everyone who was on the move, if the room they were in is still there as it was.
  const before = new Map((previous?.roamers ?? []).map((r) => [r.key, r]));
  const sameRoom = (id: string) => {
    const a = previous?.nav.rooms.get(id);
    const b = nav.rooms.get(id);
    return !!a && !!b && a.x === b.x && a.z === b.z && a.w === b.w && a.d === b.d;
  };
  for (const r of roamers) {
    const old = before.get(r.key);
    if (!old || !sameRoom(old.room) || (old.path && !old.path.every((w) => sameRoom(w.room)))) continue;
    r.obj.position.copy(old.obj.position);
    r.obj.rotation.y = old.obj.rotation.y;
    Object.assign(r, { room: old.room, path: old.path, idx: old.idx, waitUntil: old.waitUntil, seated: old.seated, errand: old.errand });
  }

  const mixers: THREE.AnimationMixer[] = [];
  let alive = true;
  loadModels(root, mixers, () => alive);
  const scripted = Object.fromEntries(Object.entries(world?.kinds ?? {}).flatMap(([id, k]) => (k.script ? [[id, k.script]] : [])));
  const scripts = Object.keys(scripted).length ? new ScriptHost(scripted) : null;

  return {
    root,
    floors,
    agents: agentNodes,
    lives,
    roamers,
    errands: new Set((previous?.errands ?? []) as Iterable<string>),
    nav,
    mixers,
    paper,
    scripts,
    dispose() {
      alive = false;
      scripts?.dispose();
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
  /** Agents that cannot work for lack of an API key: their bubble says so (and opens their settings). */
  keyMissing?: Set<string>;
  selected: string | null;
  hover: string | null;
  flights: Flight[];
  /** Actions on objects still running, by object id. */
  activity: Map<string, ObjectActivity>;
  t: number; // ms, performance.now()
  /** Wall-clock ms: objects' own rhythm and actions are timed in it. */
  clock: number;
  /** Seconds since the previous frame. */
  dt: number;
  /** World editor open: everything holds still where it was placed. */
  frozen?: boolean;
  /** Seen from above (2D): pictures instead of bodies and things. */
  flat?: boolean;
}

const DESK_TINT: Record<DeskState, string> = { off: "#4b5563", sleep: "#60a5fa", on: "#a7f3d0", working: "#4ade80" };

/** What a workstation shows, from what its person is doing. */
function deskState(work: WorkState, seated: boolean): DeskState {
  if (work === "offline") return "off";
  if (!seated) return "sleep";
  return work === "executing" || work === "thinking" ? "working" : "on";
}

/** Light a workstation's screen for its state (and, when on, its runtime's color). */
export function paintScreen(screen: THREE.MeshStandardMaterial, desk: DeskState, runtime: string, sec: number) {
  if (desk === "off") {
    screen.color.set("#0b0d12");
    screen.emissive.set("#000000");
    screen.emissiveIntensity = 0;
  } else if (desk === "sleep") {
    screen.color.set("#141c2e");
    screen.emissive.set("#3b82f6");
    screen.emissiveIntensity = 0.06 + 0.05 * Math.sin(sec * 1.3);
  } else {
    screen.color.set(SCREEN[runtime] ?? SCREEN.unknown!);
    screen.emissive.set(SCREEN[runtime] ?? "#000000");
    screen.emissiveIntensity = desk === "working" ? 0.55 + 0.35 * Math.sin(sec * 9) : 0.35;
  }
}

/** Per-frame: agent state, objects' states and behaviors, errands, flights. Only transforms and materials change here. */
export function updateScene(s: OfficeScene, f: FrameInput) {
  const sec = f.t / 1000;
  const kinds = new Map<string, PlacedLife>(s.lives.map((l) => [l.id, l]));

  // Someone was asked to do something with an object: send them over.
  if (!f.frozen) {
    for (const a of f.activity.values()) {
      const until = Date.parse(a.until);
      const key = `${a.objectId}:${a.until}`;
      if (a.by.type !== "agent" || until <= f.clock || s.errands.has(key)) continue;
      s.errands.add(key);
      const node = s.agents.get(a.by.id);
      const target = kinds.get(a.objectId);
      const gesture = target?.life.kind.actions.find((x) => x.id === a.action)?.gesture ?? "none";
      if (!node || !target || gesture === "none") continue;
      const spot = errandSpot(s.nav, target.roamer?.room ?? target.roomId, target.root.position, gesture);
      node.roamer.errand = { objectId: a.objectId, gesture, until: f.t + (until - f.clock), spot, arrived: false };
      node.roamer.path = null;
    }
  }

  for (const node of s.agents.values()) {
    const a = f.agents.get(node.id);
    if (!a) continue;
    const work = f.workOf(a);
    const offline = work === "offline";
    const r = node.roamer;
    // Offline it is not shown and holds still; it walks back when it returns.
    if (f.frozen) seat(r);
    else if (!offline && !(r.errand && stepErrand(s.nav, r, f.t, f.dt, kinds.get(r.errand.objectId)?.root.position))) stepRoamer(s.nav, r, f.t, f.dt, work !== "idle" || !r.wanders);
    const floorShown = s.floors.get(Math.round(node.actor.position.y / FLOOR_HEIGHT))?.visible ?? true;
    node.actor.visible = !offline && floorShown; // offline: an empty chair
    const walking = !r.seated && !!r.path;
    const pose = r.errand?.arrived ? r.errand.gesture : work;
    animateAvatar(node.avatar, pose, sec, r.seated ? 0 : -r.lift, walking);

    // The computer has its own state: it wakes when its person sits down and works.
    const desk = deskState(work, r.seated);
    deskStates.set(node.id, desk);
    paintScreen(node.screen, desk, a.runtime?.state ?? "none", sec);
    const flat = !!f.flat;
    node.avatar.visible = !flat;
    node.badge.visible = flat;
    for (const c of node.root.children) c.visible = c === node.deskBadge ? flat : !flat;
    if (flat) (node.deskBadge.material as THREE.SpriteMaterial).color.set(DESK_TINT[desk]);

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
    else if (f.keyMissing?.has(node.id)) [text, tone] = [t("🔑 No API key"), "bad"];
    else if (work === "blocked") [text, tone] = ["!", "bad"];
    else if (work === "error") [text, tone] = ["×", "bad"];
    else if (work === "waiting") [text, tone] = ["⌛", "plain"];
    else if (work === "thinking") [text, tone] = [".".repeat(1 + (Math.floor(f.t / 400) % 3)), "plain"];
    if (node.bubble.textContent !== text) node.bubble.textContent = text;
    node.bubble.dataset.tone = tone;
    node.bubble.style.display = text ? "" : "none";
  }

  for (const l of s.lives) {
    // From above only its picture shows (its name stays).
    if (l.badge.visible !== !!f.flat) {
      l.badge.visible = !!f.flat;
      l.life.obj.traverse((m) => {
        if (m instanceof THREE.Mesh) m.visible = !f.flat;
      });
    }
    const active = f.activity.get(l.id);
    l.life.set(objectState(l.life.kind, l.id, f.clock, active ? { state: active.state, until: Date.parse(active.until) } : null));
    if (!f.frozen) l.life.apply(sec);
    const r = l.roamer;
    if (r) {
      // It walks only in a state that roams (a napping or purring cat stays put).
      if (!f.frozen && l.life.roams) stepRoamer(s.nav, r, f.t, f.dt, false);
      else if (r.path) {
        r.path = null;
        swingLegs(r.body, 0);
      }
      // Animals and people that roam breathe, look around, wag and swing their arms like agents do.
      animateAvatar(r.body, l.life.pose, sec, -r.lift, !!r.path);
      r.obj.visible = s.floors.get(Math.round(r.obj.position.y / FLOOR_HEIGHT))?.visible ?? true;
    } else if (l.life.obj.userData.character) animateAvatar(l.life.obj, l.life.pose, sec);
  }

  if (!f.frozen) for (const m of s.mixers) m.update(Math.min(f.dt, 0.1));

  if (s.scripts && !f.frozen) {
    s.scripts.tick(f.t, sec, s.lives.map((l) => ({ id: l.id, kind: l.kindId })));
    const byId = new Map(s.lives.map((l) => [l.id, l.life.obj]));
    s.scripts.apply((id) => byId.get(id));
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

/** The placed object (index into world.objects) under a hit mesh, if any. */
export function objectIndexOf(o: THREE.Object3D | null): number | null {
  for (let x = o; x; x = x.parent) if (typeof x.userData.objectIndex === "number") return x.userData.objectIndex as number;
  return null;
}

/** The agent whose workstation a hit mesh belongs to, if any. */
export function workstationOf(o: THREE.Object3D | null): string | null {
  for (let x = o; x; x = x.parent) if (typeof x.userData.workstation === "string") return x.userData.workstation as string;
  return null;
}
