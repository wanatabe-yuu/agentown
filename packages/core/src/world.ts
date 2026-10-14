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

export const SHAPES = ["box", "cylinder", "sphere", "cone", "torus"] as const;
/** Built-in procedural characters an agent (or any object) can look like. */
export const CHARACTERS = ["person", "cat", "dog", "robot"] as const;
export const BEHAVIORS = ["spin", "bob", "pulse", "blink", "sway", "wander"] as const;
export const OBJECT_CATEGORIES = ["character", "static", "dynamic"] as const;

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
  /** How strong, as a multiple of a sensible default (wander: radius in meters). */
  amount: num(0, 20).default(1),
});
export type Behavior = z.infer<typeof behaviorSchema>;

const objectKindSchema = z.object({
  name: z.string().min(1).max(60),
  /** character: a person or an animal (can be an agent's avatar). static: furniture. dynamic: moves or glows. */
  category: z.enum(OBJECT_CATEGORIES),
  look: lookSchema,
  behaviors: z.array(behaviorSchema).max(8).default([]),
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
  wallHeight: num(0.2, 10).default(2.6),
  /** Seats for agents; by default as many as fit. */
  seats: z.number().int().min(0).max(200).optional(),
});

const floorSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(60),
  rooms: z.array(roomSchema).min(1).max(100),
});

const placementSchema = z.object({
  kind: idSchema,
  room: idSchema,
  /** Position inside the room, from its north-west corner, in meters. */
  at: z.tuple([num(0, 200), num(0, 200)]),
  rotationY: num(-360, 360).default(0),
  scale: num(0.05, 20).default(1),
  /** A name shown above it (a shop cat called Mocha). */
  label: z.string().max(40).optional(),
});

export const worldSchema = z.object({
  floors: z.array(floorSchema).min(1).max(20),
  kinds: z.record(idSchema, objectKindSchema).default({}),
  objects: z.array(placementSchema).max(2000).default([]),
  /** How agents look: per job title, else the default (a person in the department's color). */
  avatars: z.object({ default: idSchema.optional(), byJobRole: z.record(z.string(), idSchema).default({}) }).prefault({}),
});
export type World = z.infer<typeof worldSchema>;
export type Room = World["floors"][number]["rooms"][number];

/** Cross-references a world must satisfy, given the org's departments. */
export function checkWorld(world: World, departments: Set<string>, issue: (message: string) => void) {
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
  const avatar = (id: string | undefined, where: string) => {
    if (!id) return;
    const k = world.kinds[id];
    if (!k) issue(`world: ${where} uses unknown kind ${id}`);
    else if (k.category !== "character") issue(`world: ${where} must be a character, ${id} is ${k.category}`);
  };
  avatar(world.avatars.default, "avatars.default");
  for (const [role, id] of Object.entries(world.avatars.byJobRole)) avatar(id, `avatar of ${role}`);
}
