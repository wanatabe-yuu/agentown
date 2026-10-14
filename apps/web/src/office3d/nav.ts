import type { Access, World } from "@agentown/core";
import type { PlacedRoom, WorldLayout } from "./layout.ts";

/**
 * Walking around the office: which rooms something may enter (from the
 * template's `access`), and a route between two spots through doors and
 * stairs. Pure, so it is tested on its own. Rooms are rectangles, so inside a
 * room a straight line is always a valid path.
 */

export interface Spot {
  room: string;
  x: number;
  z: number;
}
export interface Waypoint extends Spot {
  y: number;
  /** Arrive here instantly (the far end of stairs or an elevator). */
  jump?: boolean;
}
interface Edge {
  to: string;
  /** Step out of `from` here … */
  a: [number, number];
  /** … and into `to` here. */
  b: [number, number];
  link: boolean;
}
export interface Nav {
  rooms: Map<string, PlacedRoom>;
  edges: Map<string, Edge[]>;
}

const INSET = 0.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The nearest point inside a room, kept off the walls. */
export function inside(r: PlacedRoom, x: number, z: number): [number, number] {
  return [clamp(x, r.x + INSET, r.x + r.w - INSET), clamp(z, r.z + INSET, r.z + r.d - INSET)];
}

export function buildNav(world: World | null, layout: WorldLayout): Nav {
  const rooms = new Map(layout.rooms.map((r) => [r.id, r]));
  const edges = new Map<string, Edge[]>(layout.rooms.map((r) => [r.id, []]));
  const add = (from: string, e: Edge) => edges.get(from)?.push(e);
  for (const f of world?.floors ?? []) {
    for (const r of f.rooms) {
      const A = rooms.get(r.id);
      for (const d of r.doors ?? []) {
        const B = rooms.get(d.to);
        if (!A || !B) continue;
        // The door's point on A's wall; each side steps to the nearest spot inside its own room.
        const wall: [number, number] =
          d.side === "north" ? [A.x + d.at, A.z] : d.side === "south" ? [A.x + d.at, A.z + A.d] : d.side === "west" ? [A.x, A.z + d.at] : [A.x + A.w, A.z + d.at];
        const a = inside(A, ...wall);
        const b = inside(B, ...wall);
        add(A.id, { to: B.id, a, b, link: false });
        add(B.id, { to: A.id, a: b, b: a, link: false });
      }
    }
  }
  for (const l of world?.links ?? []) {
    const A = rooms.get(l.from);
    const B = rooms.get(l.to);
    if (!A || !B) continue;
    const a: [number, number] = l.fromAt ? [A.x + l.fromAt[0], A.z + l.fromAt[1]] : [A.x + A.w / 2, A.z + A.d / 2];
    const b: [number, number] = l.toAt ? [B.x + l.toAt[0], B.z + l.toAt[1]] : [B.x + B.w / 2, B.z + B.d / 2];
    add(A.id, { to: B.id, a, b, link: true });
    add(B.id, { to: A.id, a: b, b: a, link: true });
  }
  return { rooms, edges };
}

/** Rooms something may enter. `home` is where it is placed or sits; `department` is an agent's (or its home room's). */
export function allowedRooms(access: Access, home: string, department: string | null, world: World | null, layout: WorldLayout): Set<string> {
  if (access === "all") return new Set(layout.rooms.map((r) => r.id));
  if (access === "own-room") return new Set([home]);
  if (access === "own-department") {
    const dept = department ?? layout.rooms.find((r) => r.id === home)?.department ?? null;
    return new Set([home, ...layout.rooms.filter((r) => dept && r.department === dept).map((r) => r.id)]);
  }
  const ids = "rooms" in access ? access.rooms : (world?.zones[access.zone] ?? []);
  return new Set([home, ...ids]);
}

/** Rooms reachable from `start` without leaving `allowed`. */
export function reachable(nav: Nav, start: string, allowed: Set<string>): string[] {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const e of nav.edges.get(queue.shift()!) ?? []) {
      if (allowed.has(e.to) && !seen.has(e.to)) {
        seen.add(e.to);
        queue.push(e.to);
      }
    }
  }
  return [...seen];
}

/** Fewest-rooms route from one spot to another, staying inside `allowed`; null when there is none. */
export function route(nav: Nav, from: Spot, to: Spot, allowed: Set<string>): Waypoint[] | null {
  const y = (room: string) => nav.rooms.get(room)?.y ?? 0;
  const prev = new Map<string, { room: string; edge: Edge } | null>([[from.room, null]]);
  const queue = [from.room];
  while (queue.length && !prev.has(to.room)) {
    const room = queue.shift()!;
    for (const e of nav.edges.get(room) ?? []) {
      if (!allowed.has(e.to) || prev.has(e.to)) continue;
      prev.set(e.to, { room, edge: e });
      queue.push(e.to);
    }
  }
  if (!prev.has(to.room)) return null;
  const hops: Edge[] = [];
  for (let at = to.room; prev.get(at); at = prev.get(at)!.room) hops.unshift(prev.get(at)!.edge);
  const out: Waypoint[] = [];
  let room = from.room;
  for (const e of hops) {
    out.push({ room, x: e.a[0], z: e.a[1], y: y(room) });
    out.push({ room: e.to, x: e.b[0], z: e.b[1], y: y(e.to), jump: e.link });
    room = e.to;
  }
  out.push({ room: to.room, x: to.x, z: to.z, y: y(to.room) });
  return out;
}
