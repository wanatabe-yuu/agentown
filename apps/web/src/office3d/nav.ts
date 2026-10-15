import type { Access, World } from "@agentown/core/world";
import type { PlacedRoom, WorldLayout } from "./layout.ts";

/**
 * Walking around the office: which rooms something may enter (from the
 * template's `access`), and a route between two spots through doors and
 * stairs. Inside a room, furniture and desks are in the way: each room keeps a
 * coarse grid of blocked cells and paths go around them. Pure, so it is tested
 * on its own.
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
  /** Per room: which grid cells something standing would bump into. */
  grids: Map<string, Grid>;
}

/** A room's floor in CELL-sized squares; true = blocked. */
interface Grid {
  x: number;
  z: number;
  cols: number;
  rows: number;
  blocked: boolean[];
}
const CELL = 0.25;
/** Half the width of someone walking: obstacles grow by this much. */
const BODY = 0.25;
/** An obstacle on the floor: an axis-aligned rectangle in absolute meters. */
export interface Footprint {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

const INSET = 0.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The nearest point inside a room, kept off the walls. */
export function inside(r: PlacedRoom, x: number, z: number): [number, number] {
  return [clamp(x, r.x + INSET, r.x + r.w - INSET), clamp(z, r.z + INSET, r.z + r.d - INSET)];
}

/**
 * What stands in the way: placed furniture (from its look's size), and every
 * occupied desk. Things that move by themselves (characters, roamers,
 * wanderers) do not block.
 */
export function footprints(world: World | null, layout: WorldLayout): Map<string, Footprint[]> {
  const out = new Map<string, Footprint[]>(layout.rooms.map((r) => [r.id, []]));
  const rooms = new Map(layout.rooms.map((r) => [r.id, r]));
  for (const o of world?.objects ?? []) {
    const kind = world!.kinds[o.kind];
    const room = rooms.get(o.room);
    if (!kind || !room || kind.category === "character" || kind.behaviors.some((b) => b.type === "roam" || b.type === "wander")) continue;
    let [hx, hz, cx, cz] = [0.3, 0.3, 0, 0];
    // Lamps overhead and rugs underfoot are no obstacle.
    const solid = "parts" in kind.look ? kind.look.parts.filter((p) => p.offset[1] - p.size[1] / 2 < 1.7 && p.offset[1] + p.size[1] / 2 > 0.06) : [];
    if ("parts" in kind.look && !solid.length) continue;
    if ("parts" in kind.look) {
      const xs = solid.flatMap((p) => [p.offset[0] - p.size[0] / 2, p.offset[0] + p.size[0] / 2]);
      const zs = solid.flatMap((p) => [p.offset[2] - p.size[2] / 2, p.offset[2] + p.size[2] / 2]);
      [hx, hz, cx, cz] = [(Math.max(...xs) - Math.min(...xs)) / 2, (Math.max(...zs) - Math.min(...zs)) / 2, (Math.max(...xs) + Math.min(...xs)) / 2, (Math.max(...zs) + Math.min(...zs)) / 2];
    } else if ("asset" in kind.look) [hx, hz] = [0.4, 0.4];
    else continue; // a character look on a non-character kind: it does not block
    // Turned a quarter: swap the sides (other angles take the larger box).
    const a = ((((o.rotationY % 360) + 360) % 360) * Math.PI) / 180;
    const [c, s] = [Math.abs(Math.cos(a)), Math.abs(Math.sin(a))];
    const [ex, ez] = [(hx * c + hz * s) * o.scale, (hx * s + hz * c) * o.scale];
    const [ox, oz] = [(cx * Math.cos(a) + cz * Math.sin(a)) * o.scale, (-cx * Math.sin(a) + cz * Math.cos(a)) * o.scale];
    const x = room.x + o.at[0] + ox;
    const z = room.z + o.at[1] + oz;
    out.get(room.id)!.push({ x0: x - ex, z0: z - ez, x1: x + ex, z1: z + ez });
  }
  // A desk is in front of its chair; the chair itself stays free so its owner can sit.
  for (const seat of layout.seatOf.values()) out.get(seat.roomId)?.push({ x0: seat.x - 0.72, z0: seat.z - 0.72, x1: seat.x + 0.72, z1: seat.z + 0.02 });
  return out;
}

function grid(r: PlacedRoom, blocks: Footprint[]): Grid {
  const cols = Math.max(1, Math.ceil(r.w / CELL));
  const rows = Math.max(1, Math.ceil(r.d / CELL));
  const blocked = new Array<boolean>(cols * rows).fill(false);
  for (const f of blocks) {
    const c0 = Math.max(0, Math.floor((f.x0 - BODY - r.x) / CELL));
    const c1 = Math.min(cols - 1, Math.floor((f.x1 + BODY - r.x) / CELL));
    const r0 = Math.max(0, Math.floor((f.z0 - BODY - r.z) / CELL));
    const r1 = Math.min(rows - 1, Math.floor((f.z1 + BODY - r.z) / CELL));
    for (let row = r0; row <= r1; row++) for (let col = c0; col <= c1; col++) blocked[row * cols + col] = true;
  }
  return { x: r.x, z: r.z, cols, rows, blocked };
}

export function buildNav(world: World | null, layout: WorldLayout): Nav {
  const rooms = new Map(layout.rooms.map((r) => [r.id, r]));
  const blocks = footprints(world, layout);
  const grids = new Map(layout.rooms.map((r) => [r.id, grid(r, blocks.get(r.id) ?? [])]));
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
  // Door and stair spots must stay reachable even when furniture stands close.
  for (const [room, list] of edges) {
    const g = grids.get(room);
    if (g) for (const e of list) free(g, e.a[0], e.a[1]);
  }
  return { rooms, edges, grids };
}

const cellOf = (g: Grid, x: number, z: number): [number, number] => [
  Math.min(g.cols - 1, Math.max(0, Math.floor((x - g.x) / CELL))),
  Math.min(g.rows - 1, Math.max(0, Math.floor((z - g.z) / CELL))),
];
const isBlocked = (g: Grid, c: number, r: number) => c < 0 || r < 0 || c >= g.cols || r >= g.rows || g.blocked[r * g.cols + c]!;
function free(g: Grid, x: number, z: number) {
  const [c, r] = cellOf(g, x, z);
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      const [cc, rr] = [c + dc, r + dr];
      if (cc >= 0 && rr >= 0 && cc < g.cols && rr < g.rows) g.blocked[rr * g.cols + cc] = false;
    }
  }
}
const center = (g: Grid, c: number, r: number): [number, number] => [g.x + (c + 0.5) * CELL, g.z + (r + 0.5) * CELL];

/** Whether a straight walk between two points crosses no blocked cell. */
function clear(g: Grid, ax: number, az: number, bx: number, bz: number): boolean {
  const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (CELL / 2));
  for (let i = 1; i < steps; i++) {
    const [c, r] = cellOf(g, ax + ((bx - ax) * i) / steps, az + ((bz - az) * i) / steps);
    if (isBlocked(g, c, r)) return false;
  }
  return true;
}

/** The nearest free cell to a point (the point itself when free). */
function nearestFree(g: Grid, x: number, z: number): [number, number] | null {
  const [c0, r0] = cellOf(g, x, z);
  for (let d = 0; d < Math.max(g.cols, g.rows); d++) {
    for (let r = r0 - d; r <= r0 + d; r++) for (let c = c0 - d; c <= c0 + d; c++) {
      if (Math.max(Math.abs(r - r0), Math.abs(c - c0)) === d && !isBlocked(g, c, r)) return [c, r];
    }
  }
  return null;
}

/** A free spot in a room, for something looking for somewhere to go. */
export function freeSpot(nav: Nav, roomId: string, x: number, z: number): [number, number] {
  const g = nav.grids.get(roomId);
  if (!g) return [x, z];
  const cell = nearestFree(g, x, z);
  return cell ? center(g, ...cell) : [x, z];
}

/** Points to walk through inside one room, around furniture (A* on the grid, then shortcuts). */
export function walkInRoom(nav: Nav, roomId: string, from: [number, number], to: [number, number]): Array<[number, number]> {
  const g = nav.grids.get(roomId);
  if (!g || clear(g, ...from, ...to)) return [to];
  const start = nearestFree(g, ...from);
  const goal = nearestFree(g, ...to);
  if (!start || !goal) return [to];
  const key = (c: number, r: number) => r * g.cols + c;
  const came = new Map<number, number>();
  const cost = new Map<number, number>([[key(...start), 0]]);
  const open: Array<[number, number, number]> = [[0, ...start]];
  const h = (c: number, r: number) => Math.hypot(c - goal[0], r - goal[1]);
  let found = false;
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [, c, r] = open.shift()!;
    if (c === goal[0] && r === goal[1]) {
      found = true;
      break;
    }
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dc && !dr) continue;
      const nc = c + dc;
      const nr = r + dr;
      // No cutting corners past a blocked cell.
      if (isBlocked(g, nc, nr) || (dc && dr && (isBlocked(g, c + dc, r) || isBlocked(g, c, r + dr)))) continue;
      const next = cost.get(key(c, r))! + Math.hypot(dc, dr);
      if (next < (cost.get(key(nc, nr)) ?? Infinity)) {
        cost.set(key(nc, nr), next);
        came.set(key(nc, nr), key(c, r));
        open.push([next + h(nc, nr), nc, nr]);
      }
    }
  }
  if (!found) return [to];
  const cells: Array<[number, number]> = [];
  for (let k: number | undefined = key(...goal); k !== undefined; k = came.get(k)) cells.unshift(center(g, k % g.cols, Math.floor(k / g.cols)));
  // Keep only the corners: skip every point a straight walk can pass.
  const pts: Array<[number, number]> = [];
  let at = from;
  for (let i = 0; i < cells.length; ) {
    let j = cells.length - 1;
    while (j > i && !clear(g, ...at, ...cells[j]!)) j--;
    pts.push(cells[j]!);
    at = cells[j]!;
    i = j + 1;
  }
  // The last step goes to the exact spot (a chair tucked against its desk is inside the margin).
  pts.push(to);
  return pts;
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
  let at: [number, number] = [from.x, from.z];
  const walk = (target: [number, number]) => {
    for (const [x, z] of walkInRoom(nav, room, at, target)) out.push({ room, x, z, y: y(room) });
    at = target;
  };
  for (const e of hops) {
    walk(e.a);
    out.push({ room: e.to, x: e.b[0], z: e.b[1], y: y(e.to), jump: e.link });
    room = e.to;
    at = e.b;
  }
  walk([to.x, to.z]);
  return out;
}
