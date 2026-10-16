import type { Room, World } from "@agentown/core/world";

/**
 * Where everything stands, in meters: rooms on floors and a seat per agent.
 * Pure (no three.js), so it is tested on its own. A world comes from the
 * organization's template; without one, every department gets a room on a
 * single floor, as the 2D office used to draw it.
 */

export const FLOOR_HEIGHT = 4; // meters between floors
const CELL = 2.4; // one desk with its chair
const MARGIN = 1.2;

export interface Seat {
  x: number;
  y: number;
  z: number;
  roomId: string;
}

export interface PlacedRoom {
  id: string;
  name: string;
  floorId: string;
  floorIndex: number;
  department: string | null;
  /** Absolute position of the north-west corner, and size. */
  x: number;
  z: number;
  y: number;
  w: number;
  d: number;
  floorColor: string;
  wallColor: string;
  wallHeight: number;
  /** How many agents fit (the template may say). */
  capacity: number;
  /** Door openings in its walls. */
  cuts: WallCut[];
  floorTexture: string | null;
  wallTexture: string | null;
  floorStyle: string | null;
  wallStyle: string | null;
  textureRepeat: number;
  /** Seat positions in order; agents take them by their seat number. */
  seats: Seat[];
  auto: boolean;
  /** Walls this room shares with a neighbor on the same floor: drawn half height so they hide nothing behind. */
  shared: { north: boolean; west: boolean };
}

/** An opening in a wall, in meters along that wall from its west/north end. */
export interface WallCut {
  side: "north" | "south" | "east" | "west";
  from: number;
  to: number;
}

/** A door between two rooms: where it meets each room's wall, for the threshold drawn between them. */
export interface DoorWay {
  a: [number, number];
  b: [number, number];
  y: number;
  width: number;
}

export interface WorldLayout {
  floors: Array<{ id: string; name: string; index: number; y: number }>;
  rooms: PlacedRoom[];
  seatOf: Map<string, Seat>;
  doors: DoorWay[];
  links: Array<{ from: [number, number, number]; to: [number, number, number]; kind: "stairs" | "elevator" }>;
}

interface Dept {
  id: string;
  name: string;
  color: string;
}
interface AgentLite {
  id: string;
  departmentId: string;
  seat: number;
  lifecycleState: string;
}

/** Desk positions that fit in a room (or `want` of them, continuing the grid past the wall if needed). */
function seatGrid(room: { x: number; z: number; y: number; w: number; d: number; id: string }, want: number): Seat[] {
  const cols = Math.max(1, Math.floor((room.w - MARGIN) / CELL));
  const out: Seat[] = [];
  for (let i = 0; i < want; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    out.push({ x: room.x + MARGIN + CELL * (c + 0.5), z: room.z + MARGIN + CELL * (r + 0.5), y: room.y, roomId: room.id });
  }
  return out;
}

export function capacity(room: { w: number; d: number; seats?: number }): number {
  return room.seats ?? Math.max(1, Math.floor((room.w - MARGIN) / CELL)) * Math.max(1, Math.floor((room.d - MARGIN) / CELL));
}

const tint = (hex: string, amount: number) => {
  const n = parseInt(hex.slice(1), 16);
  const ch = (shift: number) => Math.round(((n >> shift) & 255) + (255 - ((n >> shift) & 255)) * amount);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, "0")}`;
};

/** One room per department, two per row: the layout for organizations without a world. */
function defaultWorld(departments: Dept[], agents: AgentLite[]): World {
  const rooms: Room[] = [];
  let x = 0;
  let z = 0;
  let rowDepth = 0;
  departments.forEach((d, i) => {
    const staff = agents.filter((a) => a.departmentId === d.id).reduce((m, a) => Math.max(m, a.seat + 1), 0);
    const rows = Math.max(2, Math.ceil(Math.max(staff, 3) / 3));
    const w = 3 * CELL + MARGIN * 2;
    const depth = rows * CELL + MARGIN * 2;
    if (i > 0 && i % 2 === 0) {
      x = 0;
      z += rowDepth + 2;
      rowDepth = 0;
    }
    rooms.push({ id: `dept-${d.id}`, name: d.name, department: d.id, area: { x, z, w, d: depth }, wallHeight: 2.6, textureRepeat: 2, doors: [] });
    x += w + 2;
    rowDepth = Math.max(rowDepth, depth);
  });
  return { floors: [{ id: "main", name: "Office", rooms }], links: [], zones: {}, kinds: {}, objects: [], connectors: {}, chatTemplates: {}, avatars: { byJobRole: {}, byAgent: {} } };
}

export function layoutWorld(world: World | null, departments: Dept[], agentsAll: AgentLite[]): WorldLayout {
  const agents = agentsAll.filter((a) => a.lifecycleState !== "retired");
  const w = world ?? defaultWorld(departments, agents);
  const color = (dept: string | null | undefined) => departments.find((d) => d.id === dept)?.color ?? "#8899aa";
  const floors = w.floors.map((f, index) => ({ id: f.id, name: f.name, index, y: index * FLOOR_HEIGHT }));
  const rooms: PlacedRoom[] = w.floors.flatMap((f, index) =>
    f.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      floorId: f.id,
      floorIndex: index,
      department: r.department ?? null,
      x: r.area.x,
      z: r.area.z,
      y: index * FLOOR_HEIGHT,
      w: r.area.w,
      d: r.area.d,
      floorColor: r.floorColor ?? tint(color(r.department), 0.78),
      wallColor: r.wallColor ?? tint(color(r.department), 0.35),
      wallHeight: r.wallHeight ?? 2.6,
      capacity: capacity({ w: r.area.w, d: r.area.d, seats: r.seats }),
      cuts: [],
      floorTexture: r.floorTexture ?? null,
      wallTexture: r.wallTexture ?? null,
      floorStyle: r.floorStyle ?? null,
      wallStyle: r.wallStyle ?? null,
      textureRepeat: r.textureRepeat ?? 2,
      seats: [],
      auto: !world,
      shared: { north: false, west: false },
    })),
  );

  // Departments with staff but no room get one, east of the first floor.
  const eastEdge = Math.max(0, ...rooms.filter((r) => r.floorIndex === 0).map((r) => r.x + r.w));
  let extra = 0;
  for (const d of departments) {
    if (rooms.some((r) => r.department === d.id) || !agents.some((a) => a.departmentId === d.id)) continue;
    const n = agents.filter((a) => a.departmentId === d.id).length;
    const depth = Math.max(2, Math.ceil(n / 3)) * CELL + MARGIN * 2;
    rooms.push({
      id: `dept-${d.id}`,
      name: d.name,
      floorId: floors[0]!.id,
      floorIndex: 0,
      department: d.id,
      x: eastEdge + 2,
      z: extra,
      y: 0,
      w: 3 * CELL + MARGIN * 2,
      d: depth,
      floorColor: tint(d.color, 0.78),
      wallColor: tint(d.color, 0.35),
      wallHeight: 2.6,
      capacity: n,
      cuts: [],
      floorTexture: null,
      wallTexture: null,
      floorStyle: null,
      wallStyle: null,
      textureRepeat: 2,
      seats: [],
      auto: true,
      shared: { north: false, west: false },
    });
    extra += depth + 2;
  }

  // Seat agents in their department's rooms, in seat order; the last room takes any overflow.
  const seatOf = new Map<string, Seat>();
  for (const d of departments) {
    const own = rooms.filter((r) => r.department === d.id);
    if (!own.length) continue;
    // Ties by id: the list arrives in varying order, and nobody should swap desks because of it.
    const staff = agents.filter((a) => a.departmentId === d.id).sort((a, b) => a.seat - b.seat || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let i = 0;
    own.forEach((room, k) => {
      const take = k === own.length - 1 ? staff.length - i : Math.min(room.capacity, staff.length - i);
      room.seats = seatGrid(room, take);
      for (const s of room.seats) seatOf.set(staff[i++]!.id, s);
    });
  }
  // Doors: an opening in the room's wall and, facing it, in the other room's wall.
  const byId = new Map(rooms.map((r) => [r.id, r]));
  const OPPOSITE = { north: "south", south: "north", east: "west", west: "east" } as const;
  const doors: DoorWay[] = [];
  for (const f of w.floors) {
    for (const r of f.rooms) {
      const A = byId.get(r.id)!;
      for (const d of r.doors ?? []) {
        const B = byId.get(d.to);
        if (!B) continue;
        const along = d.side === "north" || d.side === "south";
        A.cuts.push({ side: d.side, from: d.at - d.width / 2, to: d.at + d.width / 2 });
        const abs = along ? A.x + d.at : A.z + d.at;
        const atB = along ? abs - B.x : abs - B.z;
        const lenB = along ? B.w : B.d;
        if (atB > 0 && atB < lenB) B.cuts.push({ side: OPPOSITE[d.side], from: atB - d.width / 2, to: atB + d.width / 2 });
        const wallA: [number, number] = d.side === "north" ? [abs, A.z] : d.side === "south" ? [abs, A.z + A.d] : d.side === "west" ? [A.x, abs] : [A.x + A.w, abs];
        const wallB: [number, number] =
          d.side === "north" ? [abs, B.z + B.d] : d.side === "south" ? [abs, B.z] : d.side === "west" ? [B.x + B.w, abs] : [B.x, abs];
        doors.push({ a: wallA, b: wallB, y: A.y, width: d.width });
      }
    }
  }
  const links = (w.links ?? []).flatMap((l) => {
    const A = byId.get(l.from);
    const B = byId.get(l.to);
    if (!A || !B) return [];
    const a = l.fromAt ?? [A.w / 2, A.d / 2];
    const b = l.toAt ?? [B.w / 2, B.d / 2];
    return [{ from: [A.x + a[0], A.y, A.z + a[1]] as [number, number, number], to: [B.x + b[0], B.y, B.z + b[1]] as [number, number, number], kind: l.kind }];
  });
  // A far wall (north, west) that backs onto another room would hide that room's near side.
  for (const r of rooms) {
    const same = rooms.filter((o) => o !== r && o.floorIndex === r.floorIndex);
    const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0.5;
    r.shared = {
      west: same.some((o) => o.x + o.w <= r.x + 0.1 && o.x + o.w >= r.x - 2 && overlap(o.z, o.z + o.d, r.z, r.z + r.d)),
      north: same.some((o) => o.z + o.d <= r.z + 0.1 && o.z + o.d >= r.z - 2 && overlap(o.x, o.x + o.w, r.x, r.x + r.w)),
    };
  }
  return { floors, rooms, seatOf, doors, links };
}

/** Bounding box of some rooms (for "fit" and "focus this room"). */
export function bounds(rooms: Array<Pick<PlacedRoom, "x" | "z" | "w" | "d" | "y">>) {
  if (!rooms.length) return { minX: 0, maxX: 10, minZ: 0, maxZ: 10, y: 0 };
  return {
    minX: Math.min(...rooms.map((r) => r.x)),
    maxX: Math.max(...rooms.map((r) => r.x + r.w)),
    minZ: Math.min(...rooms.map((r) => r.z)),
    maxZ: Math.max(...rooms.map((r) => r.z + r.d)),
    y: Math.max(...rooms.map((r) => r.y)),
  };
}
