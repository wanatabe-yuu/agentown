import { describe, expect, it } from "vitest";
import { worldSchema } from "@agentown/core/world";
import { FLOOR_HEIGHT, layoutWorld } from "../src/office3d/layout.ts";
import { allowedRooms, buildNav, reachable, route } from "../src/office3d/nav.ts";

const world = worldSchema.parse({
  floors: [
    {
      id: "f1",
      name: "Floor 1",
      rooms: [
        { id: "1a", name: "1A", department: "front", area: { x: 0, z: 0, w: 10, d: 8 }, doors: [{ to: "1b", side: "east", at: 4 }] },
        { id: "1b", name: "1B", department: "bar", area: { x: 11, z: 0, w: 8, d: 8 } },
        { id: "1c", name: "1C", department: "front", area: { x: 0, z: 9, w: 10, d: 6 } }, // no door: unreachable
      ],
    },
    { id: "f2", name: "Floor 2", rooms: [{ id: "2a", name: "2A", department: "bar", area: { x: 0, z: 0, w: 10, d: 8 } }] },
  ],
  links: [{ from: "1b", to: "2a", fromAt: [6, 6], toAt: [2, 2] }],
  zones: { "staff-only": ["1b", "2a"] },
});
const depts = ["front", "bar"].map((id) => ({ id, name: id, color: "#888888" }));
const layout = layoutWorld(world, depts, []);
const nav = buildNav(world, layout);
const all = new Set(layout.rooms.map((r) => r.id));

describe("walking around", () => {
  it("routes through doors and up the stairs", () => {
    const path = route(nav, { room: "1a", x: 2, z: 2 }, { room: "2a", x: 5, z: 5 }, all)!;
    expect(path.map((w) => w.room)).toEqual(["1a", "1b", "1b", "2a", "2a"]);
    // Through the east door at z = 4, from just inside 1A to just inside 1B.
    expect(path[0]).toMatchObject({ x: 9.5, z: 4 });
    expect(path[1]).toMatchObject({ x: 11.5, z: 4 });
    // Up the stairs: walk to the foot in 1B, arrive at the top in 2A.
    expect(path[2]).toMatchObject({ x: 17, z: 6, y: 0 });
    expect(path[3]).toMatchObject({ x: 2, z: 2, y: FLOOR_HEIGHT, jump: true });
    expect(path.at(-1)).toMatchObject({ room: "2a", x: 5, z: 5 });
  });

  it("never leaves the rooms it may enter", () => {
    expect(route(nav, { room: "1a", x: 2, z: 2 }, { room: "2a", x: 5, z: 5 }, new Set(["1a", "1b"]))).toBeNull();
    expect(route(nav, { room: "1a", x: 2, z: 2 }, { room: "1c", x: 5, z: 5 }, all)).toBeNull(); // no door
    expect(reachable(nav, "1b", allowedRooms({ zone: "staff-only" }, "1b", null, world, layout)).sort()).toEqual(["1b", "2a"]);
  });

  it("access comes from the template", () => {
    expect([...allowedRooms("all", "1a", null, world, layout)].sort()).toEqual(["1a", "1b", "1c", "2a"]);
    expect([...allowedRooms("own-room", "1a", null, world, layout)]).toEqual(["1a"]);
    expect([...allowedRooms("own-department", "1a", "front", world, layout)].sort()).toEqual(["1a", "1c"]);
    // An object's department is its room's.
    expect([...allowedRooms("own-department", "1b", null, world, layout)].sort()).toEqual(["1b", "2a"]);
    expect([...allowedRooms({ rooms: ["1b"] }, "1a", null, world, layout)].sort()).toEqual(["1a", "1b"]);
  });
});
