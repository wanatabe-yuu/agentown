import { z } from "zod";

/**
 * The organization's physical world: floors, rooms, and the objects in them.
 * Templates decide all of it. The platform only fixes the vocabulary: a few
 * primitive shapes, a few built-in characters, and a few behaviors. Units are
 * meters; x runs east, z runs south, rooms sit on a floor's grid.
 */

const idSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/, "lowercase dns-label id");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "color like #a1b2c3");
const num = (min: number, max: number) => z.number().min(min).max(max);
const vec3 = (min: number, max: number) => z.tuple([num(min, max), num(min, max), num(min, max)]);

export const SHAPES = ["box", "cylinder", "sphere", "cone", "torus", "capsule", "roundbox"] as const;
/** How a surface reflects light. */
export const FINISHES = ["matte", "satin", "gloss", "metal", "glass", "fabric"] as const;
/** Built-in procedural characters an agent (or any object) can look like. */
export const CHARACTERS = ["person", "cat", "dog", "robot"] as const;
/** wander: drift near where it was placed. roam: walk between rooms through doors and stairs, within its access. */
export const BEHAVIORS = ["spin", "bob", "pulse", "blink", "sway", "wander", "roam", "steam", "flicker", "rock"] as const;
export const SIDES = ["north", "south", "east", "west"] as const;
export const FLOOR_STYLES = ["plain", "wood", "tile", "checker", "concrete", "deck"] as const;
export const WALL_STYLES = ["plain", "brick", "panel", "stripe"] as const;
export const OBJECT_CATEGORIES = ["character", "static", "dynamic"] as const;
/** How a character shows a state with its body; things ignore it. */
export const POSES = ["idle", "sleep", "happy", "play", "work"] as const;
/** What someone does to trigger an action: walk over and pet it, walk over and use it, or nothing (from afar). */
export const GESTURES = ["pet", "use", "none"] as const;

const primitiveSchema = z.object({
  shape: z.enum(SHAPES),
  /** Width, height, depth in meters (sphere/cylinder/cone use x for diameter, y for height). */
  size: vec3(0.01, 20).default([1, 1, 1]),
  /** Center of the part, relative to the object's origin on the floor. */
  offset: vec3(-20, 20).default([0, 0.5, 0]),
  /** Degrees around x, y, z. */
  rotation: vec3(-360, 360).default([0, 0, 0]),
  color: color.default("#9aa3ad"),
  emissive: color.optional(),
  finish: z.enum(FINISHES).default("matte"),
  /** Name a part so a behavior can move just that part (a record on a turntable, a cat's tail). */
  part: idSchema.optional(),
});
export type Primitive = z.infer<typeof primitiveSchema>;

const lookSchema = z.union([
  z.object({ character: z.enum(CHARACTERS), color: color.optional(), accent: color.optional(), scale: num(0.1, 5).default(1) }),
  z.object({ parts: z.array(primitiveSchema).min(1).max(64) }),
  /** A model from the organization's asset library; a plain block stands in until it loads. */
  z.object({ asset: z.string().min(1).max(64), scale: num(0.01, 100).default(1), rotationY: num(-360, 360).default(0) }),
]);
export type Look = z.infer<typeof lookSchema>;

const behaviorSchema = z.object({
  type: z.enum(BEHAVIORS),
  /** Only move this named part; otherwise the whole object. */
  part: idSchema.optional(),
  /** How fast, in cycles per second. */
  speed: num(0, 20).default(1),
  /** How strong, as a multiple of a sensible default (wander: radius in meters; roam: walking speed). */
  amount: num(0, 20).default(1),
  /** Which axis spin, sway and rock turn around (default: spin y, sway z, rock x). */
  axis: z.enum(["x", "y", "z"]).optional(),
});
export type Behavior = z.infer<typeof behaviorSchema>;

/**
 * Where something that roams may go. Purely what the office shows: an agent's
 * real permissions are its grants, checked by the server.
 *   all             every room on every floor
 *   own-department  the rooms of its department (agents), or of its room's department (objects)
 *   own-room        only where it is placed / sits (the default)
 *   { rooms: [...] } or { zone: id }
 */
const accessSchema = z.union([z.enum(["all", "own-department", "own-room"]), z.object({ rooms: z.array(idSchema).min(1) }), z.object({ zone: idSchema })]);
export type Access = z.infer<typeof accessSchema>;

const avatarOverrideSchema = z.object({
  /** A character kind of this world, or a built-in character. */
  kind: idSchema.optional(),
  character: z.enum(CHARACTERS).optional(),
  color: color.optional(),
  accent: color.optional(),
  /** A picture from the asset library shown wherever this agent appears flat (chats, the 2D map). */
  image: z.string().min(1).max(64).optional(),
});
export type AvatarOverride = z.infer<typeof avatarOverrideSchema>;

/**
 * Talking is opt-in: a kind with `chat` talks (unless it says enabled: false),
 * and one placed object can be switched on or off on its own. Furniture that
 * never says anything has no chat at all.
 */
const objectChatSchema = z.object({ enabled: z.boolean().optional(), instructions: z.string().max(12000).optional() });

/**
 * What an object can be doing. The first state is its usual one; states marked
 * `auto` are ones it drifts into by itself now and then (a cat naps). While in
 * a state its `behaviors` replace the kind's (a sleeping cat stops roaming).
 */
const stateSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  behaviors: z.array(behaviorSchema).max(8).optional(),
  pose: z.enum(POSES).optional(),
  /** Glowing parts: 0 off, 1 as built, up to 3 brighter. */
  glow: num(0, 3).optional(),
  auto: z.boolean().default(false),
});
export type ObjectState = z.infer<typeof stateSchema>;

/** Something people (the owner, agents, the object itself) can do with it: puts it in `state` for a while. */
const actionSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(40),
  state: idSchema,
  seconds: num(1, 3600).default(20),
  gesture: z.enum(GESTURES).default("use"),
});

const objectKindSchema = z.object({
  chat: objectChatSchema.optional(),
  name: z.string().min(1).max(60),
  /** Default role or title shown under each one's name; an object's own `title` overrides it. */
  title: z.string().max(40).optional(),
  /** character: a person or an animal (can be an agent's avatar). static: furniture. dynamic: moves or glows. */
  category: z.enum(OBJECT_CATEGORIES),
  look: lookSchema,
  behaviors: z.array(behaviorSchema).max(8).default([]),
  access: accessSchema.default("own-room"),
  states: z.array(stateSchema).max(12).default([]),
  actions: z.array(actionSchema).max(12).default([]),
});
export type ObjectKind = z.infer<typeof objectKindSchema>;

const roomSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(60),
  /** Agents of this department sit here. A department may have several rooms. */
  department: idSchema.optional(),
  /** Position and size on the floor, in meters. */
  area: z.object({ x: num(-500, 500), z: num(-500, 500), w: num(2, 200), d: num(2, 200) }),
  floorColor: color.optional(),
  wallColor: color.optional(),
  /** Images from the asset library, tiled every `textureRepeat` meters. */
  floorTexture: z.string().min(1).max(64).optional(),
  wallTexture: z.string().min(1).max(64).optional(),
  textureRepeat: num(0.25, 50).default(2),
  /** A pattern drawn in floorColor / wallColor when there is no texture. */
  floorStyle: z.enum(FLOOR_STYLES).optional(),
  wallStyle: z.enum(WALL_STYLES).optional(),
  wallHeight: num(0.2, 10).default(2.6),
  /** Seats for agents; by default as many as fit. */
  seats: z.number().int().min(0).max(200).optional(),
  /** Openings to rooms on the same floor: which wall, how far along it (meters from its west/north end). */
  doors: z.array(z.object({ to: idSchema, side: z.enum(SIDES), at: num(0, 200), width: num(0.6, 10).default(1.2) })).max(40).default([]),
});

const floorSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(60),
  rooms: z.array(roomSchema).min(1).max(100),
});

const placementSchema = z.object({
  /** Stable identity within this organization; assigned on save for legacy templates. */
  id: idSchema.optional(),
  chat: objectChatSchema.optional(),
  kind: idSchema,
  room: idSchema,
  /** Position inside the room, from its north-west corner, in meters. */
  at: z.tuple([num(0, 200), num(0, 200)]),
  rotationY: num(-360, 360).default(0),
  scale: num(0.05, 20).default(1),
  /** A name shown above it (a shop cat called Mocha). */
  label: z.string().max(40).optional(),
  /** A smaller line under the name: a role or title (Shop cat, Barista, Music player); default: its kind's title. */
  title: z.string().max(40).optional(),
  /** Its picture in chats and on the 2D map (an image asset); default: a portrait of its model. */
  image: z.string().min(1).max(64).optional(),
});

export const worldSchema = z.object({
  /** The interface takes these colors while this world is open (a café's caramel, a lab's teal). */
  theme: z.object({ accent: color, surface: color.optional(), ink: color.optional() }).optional(),
  floors: z.array(floorSchema).min(1).max(20),
  /** Stairs or elevators between rooms on different floors; `at` is a spot in each room (default: its middle). */
  links: z
    .array(z.object({ from: idSchema, to: idSchema, kind: z.enum(["stairs", "elevator"]).default("stairs"), fromAt: z.tuple([num(0, 200), num(0, 200)]).optional(), toAt: z.tuple([num(0, 200), num(0, 200)]).optional() }))
    .max(100)
    .default([]),
  /** Named groups of rooms, for `access: { zone: … }`. */
  zones: z.record(idSchema, z.array(idSchema).min(1)).default({}),
  kinds: z.record(idSchema, objectKindSchema).default({}),
  objects: z.array(placementSchema).max(2000).default([]),
  /** How agents look: per job title, else the default (a person in the department's color). */
  avatars: z
    .object({
      default: idSchema.optional(),
      byJobRole: z.record(z.string(), idSchema).default({}),
      /** One agent's own look on top of its job's: another character, or other colors. */
      byAgent: z.record(z.string().max(64), avatarOverrideSchema).default({}),
    })
    .prefault({}),
});
export type World = z.infer<typeof worldSchema>;
export type Room = World["floors"][number]["rooms"][number];

/** Whether a placed object can be talked to (see objectChatSchema). */
export function canTalk(world: Pick<World, "kinds">, o: { kind: string; chat?: { enabled?: boolean } }): boolean {
  const kind = world.kinds[o.kind];
  return o.chat?.enabled ?? kind?.chat?.enabled ?? !!kind?.chat;
}

/** Cross-references a world must satisfy, given the org's departments. */
export function checkWorld(world: World, departments: Set<string>, issue: (message: string) => void) {
  const ids = new Set<string>();
  for (const o of world.objects) if (o.id) {
    if (ids.has(o.id)) issue(`world: duplicate object id ${o.id}`);
    ids.add(o.id);
  }
  const rooms = new Map<string, Room>();
  for (const f of world.floors) {
    for (const r of f.rooms) {
      if (rooms.has(r.id)) issue(`world: duplicate room id ${r.id}`);
      rooms.set(r.id, r);
      if (r.department && !departments.has(r.department)) issue(`world: room ${r.id} names unknown department ${r.department}`);
    }
  }
  if (new Set(world.floors.map((f) => f.id)).size !== world.floors.length) issue("world: duplicate floor id");
  for (const o of world.objects) {
    const kind = world.kinds[o.kind];
    if (!kind) issue(`world: object in ${o.room} uses unknown kind ${o.kind}`);
    const room = rooms.get(o.room);
    if (!room) issue(`world: object ${o.kind} is in unknown room ${o.room}`);
    else if (o.at[0] > room.area.w || o.at[1] > room.area.d) issue(`world: object ${o.kind} at ${o.at.join(",")} is outside room ${o.room}`);
  }
  for (const [kindId, kind] of Object.entries(world.kinds)) {
    for (const b of kind.behaviors) {
      if (b.part && !("parts" in kind.look && kind.look.parts.some((p) => p.part === b.part))) issue(`world: kind ${kindId} animates unknown part ${b.part}`);
    }
  }
  for (const [kindId, kind] of Object.entries(world.kinds)) {
    const states = new Set(kind.states.map((x) => x.id));
    if (states.size !== kind.states.length) issue(`world: kind ${kindId} has duplicate state ids`);
    for (const a of kind.actions) if (!states.has(a.state)) issue(`world: kind ${kindId} action ${a.id} puts it in unknown state ${a.state}`);
    if (new Set(kind.actions.map((a) => a.id)).size !== kind.actions.length) issue(`world: kind ${kindId} has duplicate action ids`);
    for (const st of kind.states) for (const b of st.behaviors ?? []) {
      if (b.part && !("parts" in kind.look && kind.look.parts.some((p) => p.part === b.part))) issue(`world: kind ${kindId} state ${st.id} animates unknown part ${b.part}`);
    }
  }
  const floorOf = new Map(world.floors.flatMap((f) => f.rooms.map((r) => [r.id, f.id] as const)));
  for (const r of rooms.values()) {
    for (const d of r.doors) {
      if (!rooms.has(d.to)) issue(`world: door in ${r.id} leads to unknown room ${d.to}`);
      else if (floorOf.get(d.to) !== floorOf.get(r.id)) issue(`world: door ${r.id} → ${d.to} joins different floors; use a link (stairs)`);
      const wall = d.side === "north" || d.side === "south" ? r.area.w : r.area.d;
      if (d.at > wall) issue(`world: door in ${r.id} at ${d.at} m is past the end of its ${d.side} wall`);
    }
  }
  for (const l of world.links) {
    for (const [end, at] of [[l.from, l.fromAt], [l.to, l.toAt]] as const) {
      const room = rooms.get(end);
      if (!room) issue(`world: ${l.kind} uses unknown room ${end}`);
      else if (at && (at[0] > room.area.w || at[1] > room.area.d)) issue(`world: ${l.kind} spot is outside room ${end}`);
    }
  }
  for (const [zone, ids] of Object.entries(world.zones)) for (const id of ids) if (!rooms.has(id)) issue(`world: zone ${zone} names unknown room ${id}`);
  for (const [kindId, kind] of Object.entries(world.kinds)) {
    const a = kind.access;
    if (typeof a === "object" && "rooms" in a) for (const id of a.rooms) if (!rooms.has(id)) issue(`world: kind ${kindId} may enter unknown room ${id}`);
    if (typeof a === "object" && "zone" in a && !world.zones[a.zone]) issue(`world: kind ${kindId} uses unknown zone ${a.zone}`);
    if (kind.behaviors.some((b) => b.type === "roam") && kind.category === "static") issue(`world: static kind ${kindId} cannot roam`);
  }
  const avatar = (id: string | undefined, where: string) => {
    if (!id) return;
    const k = world.kinds[id];
    if (!k) issue(`world: ${where} uses unknown kind ${id}`);
    else if (k.category !== "character") issue(`world: ${where} must be a character, ${id} is ${k.category}`);
  };
  avatar(world.avatars.default, "avatars.default");
  for (const [role, id] of Object.entries(world.avatars.byJobRole)) avatar(id, `avatar of ${role}`);
  for (const [agent, o] of Object.entries(world.avatars.byAgent)) avatar(o.kind, `avatar of agent ${agent}`);
}

/** Asset ids a world uses (models and textures), to check they exist in the organization. */
export function worldAssets(world: World | undefined): string[] {
  if (!world) return [];
  const ids = new Set<string>();
  for (const k of Object.values(world.kinds)) if ("asset" in k.look) ids.add(k.look.asset);
  for (const f of world.floors) for (const r of f.rooms) for (const t of [r.floorTexture, r.wallTexture]) if (t) ids.add(t);
  for (const o of world.objects) if (o.image) ids.add(o.image);
  for (const a of Object.values(world.avatars.byAgent)) if (a.image) ids.add(a.image);
  return [...ids];
}

/**
 * The state an object is in right now: an action someone took (until it runs
 * out), else one of its `auto` states when its own rhythm says so, else its
 * first state. The rhythm is a pure function of time and the object's id, so
 * every viewer sees the same nap at the same moment.
 */
export function objectState(kind: Pick<ObjectKind, "states">, objectId: string, now: number, active?: { state: string; until: number } | null): ObjectState | null {
  if (!kind.states.length) return null;
  if (active && active.until > now) return kind.states.find((x) => x.id === active.state) ?? kind.states[0]!;
  const autos = kind.states.filter((x) => x.auto);
  if (!autos.length) return kind.states[0]!;
  // Cycles of 60–150 s; the object spends roughly the last third of each in an auto state.
  let h = 2166136261;
  for (let i = 0; i < objectId.length; i++) h = Math.imul(h ^ objectId.charCodeAt(i), 16777619);
  const seed = (h >>> 0) / 4294967295;
  const period = 60_000 + seed * 90_000;
  const cycle = Math.floor((now + seed * period) / period);
  const phase = ((now + seed * period) % period) / period;
  return phase > 0.66 ? autos[cycle % autos.length]! : kind.states[0]!;
}
