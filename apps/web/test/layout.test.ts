import { describe, expect, it } from "vitest";
import { worldSchema } from "@agentown/core/world";
import { bounds, capacity, FLOOR_HEIGHT, layoutWorld } from "../src/office3d/layout.ts";

const depts = [
  { id: "front", name: "Front", color: "#c08040" },
  { id: "bar", name: "Bar", color: "#4060c0" },
  { id: "ops", name: "Ops", color: "#40a060" },
];
const agent = (id: string, departmentId: string, seat: number) => ({ id, departmentId, seat, lifecycleState: "active" });

describe("office layout", () => {
  it("without a world, every department gets a room on one floor", () => {
    const l = layoutWorld(null, depts, [agent("a", "front", 0), agent("b", "bar", 0), agent("c", "bar", 1)]);
    expect(l.floors).toHaveLength(1);
    expect(l.rooms.map((r) => r.department)).toEqual(["front", "bar", "ops"]);
    expect(l.seatOf.get("c")!.roomId).toBe("dept-bar");
    // Rooms do not overlap.
    const [a, b] = l.rooms;
    expect(a!.x + a!.w).toBeLessThan(b!.x);
  });

  it("a template's floors, rooms and seats decide where agents sit", () => {
    const world = worldSchema.parse({
      floors: [
        { id: "f1", name: "Floor 1", rooms: [{ id: "1a", name: "1A", department: "front", area: { x: 0, z: 0, w: 6, d: 4 }, seats: 2 }, { id: "1b", name: "1B", department: "front", area: { x: 7, z: 0, w: 6, d: 6 } }] },
        { id: "f2", name: "Floor 2", rooms: [{ id: "2a", name: "2A", department: "bar", area: { x: 0, z: 0, w: 8, d: 8 } }] },
      ],
    });
    const l = layoutWorld(world, depts, [agent("a", "front", 0), agent("b", "front", 1), agent("c", "front", 2), agent("d", "bar", 0), agent("e", "ops", 0)]);
    expect(l.seatOf.get("a")!.roomId).toBe("1a");
    expect(l.seatOf.get("b")!.roomId).toBe("1a");
    expect(l.seatOf.get("c")!.roomId).toBe("1b"); // 1A holds two
    expect(l.seatOf.get("d")).toMatchObject({ roomId: "2a", y: FLOOR_HEIGHT });
    // Ops has staff but no room: it gets one beside the first floor.
    const ops = l.rooms.find((r) => r.department === "ops")!;
    expect(ops.auto).toBe(true);
    expect(ops.x).toBeGreaterThanOrEqual(13);
    expect(l.seatOf.get("e")!.roomId).toBe(ops.id);
    // Seats are inside their room.
    for (const [, s] of l.seatOf) {
      const r = l.rooms.find((x) => x.id === s.roomId)!;
      expect(s.x).toBeGreaterThan(r.x);
      expect(s.x).toBeLessThan(r.x + r.w);
    }
    expect(capacity({ w: 6, d: 4, seats: 2 })).toBe(2);
    expect(bounds(l.rooms.filter((r) => r.floorIndex === 1))).toMatchObject({ minX: 0, maxX: 8, y: FLOOR_HEIGHT });
  });
});
