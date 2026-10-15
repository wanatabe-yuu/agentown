import { worldSchema } from "@agentown/core/world";
import { describe, expect, it } from "vitest";
import { layoutWorld } from "../src/office3d/layout.ts";
import { buildNav, footprints, freeSpot, route, walkInRoom } from "../src/office3d/nav.ts";

const world = worldSchema.parse({
  floors: [{ id: "f", name: "F", rooms: [
    { id: "a", name: "A", area: { x: 0, z: 0, w: 8, d: 6 }, seats: 0, doors: [{ to: "b", side: "east", at: 3 }] },
    { id: "b", name: "B", area: { x: 9, z: 0, w: 6, d: 6 }, seats: 0 },
  ] }],
  kinds: {
    table: { name: "Table", category: "static", look: { parts: [{ shape: "box", size: [2, 1, 2], offset: [0, 0.5, 0] }] } },
    cat: { name: "Cat", category: "dynamic", look: { character: "cat" }, behaviors: [{ type: "roam" }] },
  },
  objects: [{ kind: "table", room: "a", at: [4, 3] }, { kind: "cat", room: "a", at: [1, 1] }],
});
const layout = layoutWorld(world, [], []);
const nav = buildNav(world, layout);
const inTable = ([x, z]: [number, number]) => x > 3 && x < 5 && z > 2 && z < 4;

describe("walking around furniture", () => {
  it("knows what blocks: furniture yes, a roaming cat no", () => {
    expect(footprints(world, layout).get("a")).toEqual([{ x0: 3, z0: 2, x1: 5, z1: 4 }]);
  });

  it("goes around a table instead of through it", () => {
    const pts = walkInRoom(nav, "a", [1, 3], [7, 3]);
    expect(pts.length).toBeGreaterThan(1);
    expect(pts.at(-1)).toEqual([7, 3]);
    // Every leg stays clear of the table.
    let at: [number, number] = [1, 3];
    for (const p of pts) {
      for (let k = 0; k <= 20; k++) expect(inTable([at[0] + ((p[0] - at[0]) * k) / 20, at[1] + ((p[1] - at[1]) * k) / 20])).toBe(false);
      at = p;
    }
    expect(walkInRoom(nav, "a", [1, 1], [7, 1])).toEqual([[7, 1]]); // nothing in the way: straight
  });

  it("picks free spots and routes through doors around furniture", () => {
    expect(inTable(freeSpot(nav, "a", 4, 3))).toBe(false);
    const path = route(nav, { room: "a", x: 1, z: 3 }, { room: "b", x: 12, z: 3 }, new Set(["a", "b"]))!;
    expect(path.at(-1)).toMatchObject({ room: "b", x: 12, z: 3 });
    expect(path.filter((w) => w.room === "a").some((w) => inTable([w.x, w.z]))).toBe(false);
  });
});
