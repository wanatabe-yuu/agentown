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

/** extrude: a 2D outline (points x,y) pushed into depth. lathe: a profile (points radius,y) turned around the y axis. */
export const SHAPES = ["box", "cylinder", "sphere", "cone", "torus", "capsule", "roundbox", "extrude", "lathe"] as const;
/** How a surface reflects light. */
export const FINISHES = ["matte", "satin", "gloss", "metal", "glass", "fabric"] as const;
/** Built-in procedural characters an agent (or any object) can look like. */
export const CHARACTERS = ["person", "cat", "dog", "robot"] as const;
/** wander: drift near where it was placed. roam: walk between rooms through doors and stairs, within its access. */
/** keyframes: loop through the behavior's keys (offsets from where the part rests). */
export const BEHAVIORS = ["spin", "bob", "pulse", "blink", "sway", "wander", "roam", "steam", "flicker", "rock", "keyframes"] as const;
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
  /** Fine-tune the finish (0–1); opacity below 1 makes the part see-through. */
  roughness: num(0, 1).optional(),
  metalness: num(0, 1).optional(),
  opacity: num(0.05, 1).optional(),
  /** For extrude and lathe: the outline, in any units; it is stretched to `size`. */
  points: z.array(z.tuple([num(-100, 100), num(-100, 100)])).min(2).max(64).optional(),
  /** Name a part so a behavior can move just that part (a record on a turntable, a cat's tail). */
  part: idSchema.optional(),
}).refine((p) => (p.shape !== "extrude" && p.shape !== "lathe") || (p.points?.length ?? 0) >= (p.shape === "extrude" ? 3 : 2), {
  message: "extrude needs at least 3 points, lathe at least 2",
  path: ["points"],
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
  /** For keyframes: poses over one loop (t from 0 to 1), as offsets from the resting pose; in between is smoothed. */
  keys: z
    .array(z.object({ t: num(0, 1), position: vec3(-20, 20).optional(), rotation: vec3(-360, 360).optional(), scale: num(0.01, 20).optional() }))
    .min(2)
    .max(16)
    .optional(),
}).refine((b) => b.type !== "keyframes" || !!b.keys, { message: "keyframes needs keys", path: ["keys"] });
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

export const COMPUTER_APPS = ["browser", "mcp", "stream", "camera", "terminal"] as const;
export type ComputerApp = (typeof COMPUTER_APPS)[number];
const computerFields = {
  apps: z.array(z.enum(COMPUTER_APPS)).min(1).default(["browser"]),
  /** browser: the page it opens first. */
  home: z.string().url().max(500).optional(),
  /** mcp: the world's connectors (ids) this computer may call; attaching one is the owner's approval. */
  connectors: z.array(z.string().max(64)).max(20).default([]),
  /** stream: what it plays when asked to play without a link (a video file, HLS .m3u8, or any page). */
  stream: z.string().url().max(1000).optional(),
  /** camera: an image, MJPEG or HLS feed; it looks every so often and reports changes it was told to watch for. */
  camera: z.object({
    url: z.string().url().max(1000),
    everySeconds: z.number().int().min(10).max(3600).default(60),
    watchFor: z.string().max(500).optional(),
    /** The agent that gets a task when it sees something worth reporting. */
    notify: z.string().max(64).optional(),
  }).optional(),
};
/** On a kind: the defaults of its computers (older worlds kept a computer's settings here). */
const computerSchema = z.object(computerFields);
/**
 * On one placed computer: off (a desk ornament) until `studio` is on; then it runs in a
 * container of its own (its own browser profile and network: direct, a proxy or a VPN,
 * whose secrets the owner sets apart), or, with `remote`, on a paired machine elsewhere.
 */
const placedComputerSchema = z.object({
  studio: z.boolean().default(false),
  ...computerFields,
  network: z.enum(["direct", "proxy", "vpn"]).default("direct"),
  remote: z.boolean().default(false),
}).refine((c) => !(c.apps.includes("terminal") && c.network !== "direct" && !c.remote), {
  // A shell in the computer reads what its runtime holds, its proxy login or VPN key included.
  message: "a computer with a terminal browses directly: its shell could read the proxy or VPN secret",
  path: ["network"],
});
export type Computer = z.infer<typeof computerSchema> & { network?: "direct" | "proxy" | "vpn"; remote?: boolean };
export type PlacedComputer = z.infer<typeof placedComputerSchema>;

/**
 * When something runs: a time of day on some weekdays (0 Sunday … 6 Saturday), in
 * the time zone of whoever set it. The cleaning robot and the trash can each have one.
 */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 02:30");
const timeZoneSchema = z.string().min(1).max(64).refine((tz) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "an IANA time zone such as Asia/Ho_Chi_Minh");
const scheduleSchema = z.object({
  at: hhmm.default("02:00"),
  days: z.array(z.number().int().min(0).max(6)).min(1).max(7).default([0, 1, 2, 3, 4, 5, 6]),
  timeZone: timeZoneSchema.default("UTC"),
});
export type Schedule = z.infer<typeof scheduleSchema>;
/** One kind of leftover the robot picks up: on or off, and how old it must be. */
const sweepPart = (enabled: boolean, days: number) => z.object({ enabled: z.boolean().default(enabled), days: z.number().int().min(1).max(3650).default(days) }).prefault({});
/**
 * The cleaning robot: on its schedule it moves what is old enough into the trash can.
 *   workspace  outputs of finished tasks in team workspaces, and retired members' folders
 *   downloads  downloads and browser cache on the world's computers (logins stay)
 *   history    activity, logs, team messages, finished proposals and computer requests, files of finished runs
 *   chats      chats archived that long ago
 *   assets     art no object in the world uses any more
 * The audit log is never swept.
 */
export const cleanerSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: scheduleSchema.prefault({ at: "02:00" }),
  workspace: sweepPart(true, 14),
  downloads: sweepPart(true, 7),
  history: sweepPart(false, 90),
  chats: sweepPart(false, 30),
  assets: sweepPart(false, 30),
});
export type CleanerSettings = z.infer<typeof cleanerSettingsSchema>;
/** The trash can: on its schedule it deletes for good what has been in it at least keepDays. */
export const trashSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  schedule: scheduleSchema.prefault({ at: "03:00" }),
  keepDays: z.number().int().min(0).max(3650).default(7),
});
export type TrashSettings = z.infer<typeof trashSettingsSchema>;
export const SWEEP_PARTS = ["workspace", "downloads", "history", "chats", "assets"] as const;
export type SweepPart = (typeof SWEEP_PARTS)[number];

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
  /**
   * JavaScript run in a locked sandbox in each viewer's browser (no network, no
   * page, no cookies). It calls api.onTick((obj, t) => obj.set(part, pose)) with
   * poses as offsets: position [m], rotation [deg], scale, color, visible.
   */
  script: z.string().max(8000).optional(),
  /**
   * A computer: each one placed is a real Chromium (with a screen, not
   * headless) that agents drive with `agentown browser` and people watch, or
   * take over to log in, from the object's inspector. `home` opens first.
   */
  browser: z.object({ home: z.string().url().max(500).optional() }).optional(),
  /**
   * A computer that waits for requests like an agent (from agents, people chatting
   * with it, or its own camera), one at a time, and does them with its apps. Its screen
   * shows one app at a time. `browser` alone is the same as apps ["browser"].
   */
  computer: computerSchema.optional(),
  /** The cleaning robot: it sweeps on a schedule (settings on each placed one). */
  cleaner: z.object({}).strict().optional(),
  /** The trash can the robot empties into; it deletes for good on its own schedule. */
  trash: z.object({}).strict().optional(),
  /** The wall calendar: opens the organization's month of scheduled jobs. */
  calendar: z.object({}).strict().optional(),
});
export type ObjectKind = z.infer<typeof objectKindSchema>;

/** Whether objects of this kind are computers (they may run, with studio on). */
export function isComputerKind(kind: Pick<ObjectKind, "browser" | "computer"> | undefined): boolean {
  return !!(kind?.computer || kind?.browser);
}

/**
 * What a placed computer runs: its own settings when it has them (null while studio is off),
 * else its kind's (worlds from before per-object settings: every such computer ran).
 */
export function computerOf(kind: Pick<ObjectKind, "browser" | "computer"> | undefined, object?: { computer?: PlacedComputer }): Computer | null {
  if (!isComputerKind(kind)) return null;
  const own = object?.computer;
  if (own) return own.studio ? own : null;
  return kind!.computer ?? { apps: ["browser"], home: kind!.browser?.home, connectors: [] };
}

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
  /** A computer's own settings (its kind must be a computer: `computer` or `browser`). */
  computer: placedComputerSchema.optional(),
  /** A cleaning robot's settings (its kind must be a `cleaner`). */
  cleaner: cleanerSettingsSchema.optional(),
  /** A trash can's settings (its kind must be a `trash`). */
  trash: trashSettingsSchema.optional(),
});

/**
 * An MCP server the organization's agents may call (Streamable HTTP). Its
 * credential is set by the owner and never part of the world. ask: every call
 * waits for approval; auto: calls run at once.
 */
const connectorSchema = z.object({
  name: z.string().min(1).max(60),
  url: z.string().url().max(500),
  description: z.string().max(400).optional(),
  approval: z.enum(["ask", "auto"]).default("ask"),
});
export type Connector = z.infer<typeof connectorSchema>;

export const worldSchema = z.object({
  /** The interface takes these colors while this world is open (a café's caramel, a lab's teal). */
  theme: z.object({ accent: color, surface: color.optional(), ink: color.optional() }).optional(),
  /** How the 3D office is drawn: lit and soft (default), or anime (flat cel shading, ink outlines, big-eyed characters). */
  style: z.enum(["realistic", "anime"]).optional(),
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
  /** Each agent's PC at their desk ("desk:<agent id>"): its name and settings, by agent id (studio off: just a PC on the desk). */
  desks: z.record(z.string().min(1).max(64), placedComputerSchema.and(z.object({ label: z.string().trim().min(1).max(40).optional() }))).default({}),
  /**
   * Chat personas by title: every object whose title (its own, else its kind's)
   * is listed here can be talked to and speaks this way. Instructions set on its
   * kind or on the object itself come on top.
   */
  chatTemplates: z.record(z.string().min(1).max(40), z.object({ instructions: z.string().min(1).max(12000) })).default({}),
  /** Outside tools (MCP servers) that come with this world. */
  connectors: z.record(idSchema, connectorSchema).default({}),
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

type ChatWorld = Pick<World, "kinds"> & { chatTemplates?: World["chatTemplates"] };
type ChatObject = { kind: string; title?: string; chat?: { enabled?: boolean } };

/** The world's chat template for an object, by its title (its own, else its kind's). */
export function chatTemplateOf(world: ChatWorld, o: ChatObject) {
  const title = o.title ?? world.kinds[o.kind]?.title;
  return title ? world.chatTemplates?.[title] : undefined;
}

/** Whether a placed object can be talked to (see objectChatSchema and chatTemplates). */
export function canTalk(world: ChatWorld, o: ChatObject): boolean {
  const kind = world.kinds[o.kind];
  // A computer talks: what is said to it becomes a request it does.
  return o.chat?.enabled ?? kind?.chat?.enabled ?? (!!kind?.chat || !!computerOf(kind, o as { computer?: PlacedComputer }) || !!chatTemplateOf(world, o));
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
    if (o.cleaner && kind && !kind.cleaner) issue(`world: object ${o.id ?? o.kind} has cleaning settings but ${o.kind} is not a cleaning robot`);
    if (o.trash && kind && !kind.trash) issue(`world: object ${o.id ?? o.kind} has trash settings but ${o.kind} is not a trash can`);
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

/**
 * The world's cleaning robot and trash can (the first placed one of each), with their
 * settings filled in. The robot needs a trash can to empty into.
 */
export function cleanupOf(world: World | null | undefined) {
  const first = <T>(flag: "cleaner" | "trash", parse: (v: unknown) => T) => {
    const o = world?.objects.find((x) => x.id && world.kinds[x.kind]?.[flag]);
    return o ? { objectId: o.id!, name: o.label ?? world!.kinds[o.kind]!.name, settings: parse(o[flag] ?? {}) } : null;
  };
  return { cleaner: first("cleaner", (v) => cleanerSettingsSchema.parse(v)), trash: first("trash", (v) => trashSettingsSchema.parse(v)) };
}

/** The calendar day and minute of the day at `now` in a time zone. */
export function localClock(timeZone: string, now: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute), weekday };
}

/** How long after its time a schedule may still run (the server was down at the minute itself). */
export const SCHEDULE_GRACE_MINUTES = 360;

/**
 * Whether a schedule is due at `now`: a scheduled weekday, at most a few hours past its
 * time, and it has not run yet on that local day. Returns the local day to remember, or null.
 * A world created in the afternoon does not run its 02:00 sweep until the next night.
 */
export function scheduleDue(schedule: Schedule, now: Date, lastDay: string | null): string | null {
  const c = localClock(schedule.timeZone, now);
  const [h, m] = schedule.at.split(":").map(Number);
  const late = c.minute - (h! * 60 + m!);
  // ponytail: a time near midnight whose grace runs into the next day is missed on that next day; fine for nightly sweeps
  if (!schedule.days.includes(c.weekday) || late < 0 || late >= SCHEDULE_GRACE_MINUTES || lastDay === c.day) return null;
  return c.day;
}

/**
 * A job on the wall calendar: an object doing one of its actions, or an agent
 * given a task, either every week (a time on each chosen weekday, 0 Sunday … 6
 * Saturday) or once (a day and a time), in the time zone of whoever set it.
 */
export const calendarJobSchema = z
  .object({
    title: z.string().trim().min(1).max(80),
    who: z.object({ type: z.enum(["object", "agent"]), id: z.string().min(1).max(64) }),
    /** object: the id of one of its kind's actions. */
    action: z.string().min(1).max(64).optional(),
    /** agent: what the task asks. */
    prompt: z.string().trim().min(1).max(4000).optional(),
    repeat: z.discriminatedUnion("type", [
      z.object({ type: z.literal("weekly"), times: z.array(hhmm.nullable()).length(7).refine((t) => t.some(Boolean), "pick at least one day") }),
      z.object({ type: z.literal("once"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day like 2026-10-20"), at: hhmm }),
    ]),
    timeZone: timeZoneSchema,
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine((j) => (j.who.type === "object" ? !!j.action && !j.prompt : !!j.prompt && !j.action), {
    message: "an object does one of its actions; an agent gets a prompt",
    path: ["who"],
  });
export type CalendarJob = z.infer<typeof calendarJobSchema>;
export type JobRepeat = CalendarJob["repeat"];

/** A robot's or trash can's schedule as a weekly repeat (the same time on each of its days). */
export const weeklyOf = (s: Schedule): JobRepeat => ({ type: "weekly", times: [0, 1, 2, 3, 4, 5, 6].map((d) => (s.days.includes(d) ? s.at : null)) });

/** When a job runs on a local day (YYYY-MM-DD, its weekday 0-6), or null. */
export function jobTimeOn(repeat: JobRepeat, day: string, weekday: number): string | null {
  return repeat.type === "weekly" ? (repeat.times[weekday] ?? null) : repeat.date === day ? repeat.at : null;
}

/** The local day a job is due on at `now` (at most a few hours past its time), or null. */
export function jobDue(job: { repeat: JobRepeat; timeZone: string }, now: Date): string | null {
  const c = localClock(job.timeZone, now);
  const at = jobTimeOn(job.repeat, c.day, c.weekday);
  if (!at) return null;
  const late = c.minute - (Number(at.slice(0, 2)) * 60 + Number(at.slice(3)));
  return late >= 0 && late < SCHEDULE_GRACE_MINUTES ? c.day : null;
}

/** A world's file in a template bundle: referenced by its path, e.g. assets/sofa.glb. */
export const BUNDLE_PATH = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,56}$/;

/**
 * Every art reference of a raw world (as a template carries it), with what it must be
 * (a model or a texture), rewritten by `map` (return the same ref to keep it).
 */
export function mapWorldAssets(world: unknown, map: (ref: string, kind: "model" | "texture") => string): unknown {
  if (!world || typeof world !== "object") return world;
  const w = structuredClone(world) as Record<string, any>;
  const swap = (o: Record<string, any> | undefined, key: string, kind: "model" | "texture") => {
    if (o && typeof o[key] === "string") o[key] = map(o[key], kind);
  };
  for (const k of Object.values(w.kinds ?? {}) as Array<Record<string, any>>) swap(k?.look, "asset", "model");
  for (const f of w.floors ?? []) for (const r of f?.rooms ?? []) for (const key of ["floorTexture", "wallTexture"]) swap(r, key, "texture");
  for (const o of w.objects ?? []) swap(o, "image", "texture");
  for (const a of Object.values(w.avatars?.byAgent ?? {}) as Array<Record<string, any>>) swap(a, "image", "texture");
  return w;
}
