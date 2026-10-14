import { newId } from "./util.ts";
/** Assign only absent IDs. Moving/reordering keeps existing object conversations attached. */
export function worldIdentities<T extends Record<string, unknown>>(doc: T): T {
  const world = doc.world as Record<string, unknown> | undefined;
  if (!world || !Array.isArray(world.objects)) return doc;
  const used = new Set(world.objects.map(o => o?.id).filter(Boolean));
  return { ...doc, world: { ...world, objects: world.objects.map(o => {
    if (!o || typeof o !== "object" || o.id !== undefined) return o;
    let id: string; do { id = newId("obj", 8); } while (used.has(id));
    used.add(id); return { ...o, id };
  }) } };
}
