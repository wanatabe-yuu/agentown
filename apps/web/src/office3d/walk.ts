import * as THREE from "three";
import { FLOOR_HEIGHT } from "./layout.ts";
import { freeSpot, inside, type Nav, reachable, route, type Spot, type Waypoint } from "./nav.ts";

/**
 * Walking: everyone and everything that moves between rooms. People sit at
 * their desk while they work, stroll when idle (if their look roams), and go
 * on errands to objects; animals and robots roam within their access.
 */

/** Something that walks between rooms, through doors and stairs, within its access. */
export interface Roamer {
  /** Who it is ("agent:id", "object:id"), to carry it over when the scene is rebuilt. */
  key: string;
  /** No way found home this many times in a row. */
  lost: number;
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
  /** Strolls about when idle (its look roams); otherwise it stays at its desk unless sent somewhere. */
  wanders: boolean;
  /** Sent to do something with an object: walk there, do it, come back. */
  errand: Errand | null;
}

export interface Errand {
  objectId: string;
  gesture: "pet" | "use";
  /** performance.now() time it ends. */
  until: number;
  spot: Spot;
  arrived: boolean;
}


/** Put an agent straight back in its chair (the editor is open, or there is no way back). */
export function seat(r: Roamer) {
  if (!r.home) return;
  r.obj.position.set(r.home.x, r.obj.position.y, r.home.z);
  r.obj.position.y = Math.round(r.obj.position.y / FLOOR_HEIGHT) * FLOOR_HEIGHT;
  r.room = r.home.room;
  r.obj.rotation.y = 0;
  r.path = null;
  r.seated = true;
  r.lost = 0;
  r.errand = null;
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

/** One frame along the current path. Stairs and elevators are climbed too (slower), not jumped. */
function advance(r: Roamer, now: number, dt: number): "idle" | "walking" | "arrived" {
  const wp = r.path?.[r.idx];
  if (!wp) {
    swingLegs(r.body, 0);
    return "idle";
  }
  const dx = wp.x - r.obj.position.x;
  const dy = wp.y - r.obj.position.y;
  const dz = wp.z - r.obj.position.z;
  const flat = Math.hypot(dx, dz);
  const dist = Math.hypot(flat, dy);
  // A slow frame still moves at walking speed; a long pause (a hidden tab) does not jump ahead.
  const stepLen = r.speed * (wp.jump ? 0.6 : 1) * Math.min(dt, 0.5);
  if (dist > stepLen) {
    r.obj.position.x += (dx / dist) * stepLen;
    r.obj.position.y += (dy / dist) * stepLen;
    r.obj.position.z += (dz / dist) * stepLen;
    if (flat > 0.02) turnToward(r.obj, Math.atan2(-dx, -dz), dt);
    swingLegs(r.body, Math.sin(now / 110) * 0.5);
    return "walking";
  }
  r.obj.position.set(wp.x, wp.y, wp.z);
  r.room = wp.room;
  r.idx++;
  if (r.idx < r.path!.length) return "walking";
  r.path = null;
  swingLegs(r.body, 0);
  return "arrived";
}

/** Walk to an object and do the action there until it is over. False once there is nothing (left) to do. */
export function stepErrand(nav: Nav, r: Roamer, now: number, dt: number, target: THREE.Vector3 | undefined): boolean {
  const e = r.errand!;
  if (now > e.until) {
    r.errand = null;
    return false;
  }
  if (e.arrived) {
    if (target) turnToward(r.obj, Math.atan2(-(target.x - r.obj.position.x), -(target.z - r.obj.position.z)), dt);
    swingLegs(r.body, 0);
    return true;
  }
  const last = r.path?.at(-1);
  if (!last || last.x !== e.spot.x || last.z !== e.spot.z) {
    r.seated = false;
    // Sent by someone who may: any room on the way.
    r.path = route(nav, { room: r.room, x: r.obj.position.x, z: r.obj.position.z }, e.spot, new Set(nav.rooms.keys()));
    r.idx = 0;
    if (!r.path) {
      r.errand = null;
      return false;
    }
  }
  if (advance(r, now, dt) === "arrived") e.arrived = true;
  return true;
}

/**
 * One frame of walking. Agents that should work head for their chair and sit;
 * everything else rests a while, then picks a room it may enter and walks there.
 */
export function stepRoamer(nav: Nav, r: Roamer, now: number, dt: number, goHome: boolean) {
  const here: Spot = { room: r.room, x: r.obj.position.x, z: r.obj.position.z };
  if (goHome && r.home) {
    if (r.seated) return;
    const last = r.path?.at(-1);
    if (!last || last.x !== r.home.x || last.z !== r.home.z) {
      if (now < r.waitUntil) return;
      // From an errand too, the way back may cross rooms it would not stroll into.
      r.path = route(nav, here, r.home, r.allowed.has(r.room) ? r.allowed : new Set(nav.rooms.keys()));
      r.idx = 0;
      // No way home (a door was removed meanwhile): try again shortly, and only give up after a few tries.
      if (!r.path) {
        r.waitUntil = now + 2000;
        if (++r.lost >= 3) seat(r);
        return;
      }
      r.lost = 0;
    }
    if (advance(r, now, dt) === "arrived") {
      r.seated = true;
      r.obj.rotation.y = 0;
    }
    return;
  }
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
  if (advance(r, now, dt) === "arrived") r.waitUntil = now + 1500 + Math.random() * 4000;
}

