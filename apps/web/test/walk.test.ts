import { readFileSync } from "node:fs";
import { parseTemplate, splitInstanceConfig } from "@agentown/core";
import { worldSchema } from "@agentown/core/world";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { layoutWorld } from "../src/office3d/layout.ts";
import { allowedRooms, buildNav } from "../src/office3d/nav.ts";
import { errandSpot, type Roamer, stepErrand, stepRoamer } from "../src/office3d/walk.ts";

// The coffee shop as shipped, with a few people at their desks.
const { catalog } = splitInstanceConfig(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));
const doc = parseTemplate(readFileSync(new URL("../../../config/templates/coffee-store.yaml", import.meta.url), "utf8"), catalog).doc as { world: unknown; departments: Array<{ id: string; name: string; color: string }> };
const world = worldSchema.parse(doc.world);
const people = ["front", "bar", "kitchen", "management", "roastery", "studio"].map((d, i) => ({ id: `a-${i}`, departmentId: d, seat: 0, lifecycleState: "active", jobRole: "x" }));
const layout = layoutWorld(world, doc.departments, people);
const nav = buildNav(world, layout);
const roomOf = new Map(layout.rooms.map((r) => [r.id, r]));

function person(id: string): Roamer {
  const seat = layout.seatOf.get(id)!;
  const obj = new THREE.Object3D();
  obj.position.set(seat.x, seat.y, seat.z + 0.3);
  return {
    key: `agent:${id}`, lost: 0, obj, body: new THREE.Object3D(), allowed: allowedRooms("own-room", seat.roomId, null, world, layout), room: seat.roomId,
    speed: 1.1, path: null, idx: 0, waitUntil: 0, lift: 0, home: { room: seat.roomId, x: seat.x, z: seat.z + 0.3 }, seated: true, seed: 0.3, wanders: true, errand: null,
  };
}

/** Run at 60 frames a second; fail on any frame that moves farther than walking allows (a teleport). */
function run(r: Roamer, seconds: number, step: (now: number, dt: number) => boolean | void) {
  const dt = 1 / 60;
  let worst = 0;
  for (let k = 0, now = 1000; k < seconds * 60; k++, now += dt * 1000) {
    const before = r.obj.position.clone();
    if (step(now, dt) === false) break;
    worst = Math.max(worst, before.distanceTo(r.obj.position));
  }
  return worst;
}

describe("walking over to do something with an object", () => {
  const targets = world.objects.filter((o) => world.kinds[o.kind]!.actions.some((a) => a.gesture !== "none"));
  it("covers the things people walk to in the coffee shop", () => {
    expect(new Set(targets.map((o) => o.kind))).toEqual(new Set(["shop-cat", "espresso-station", "jukebox", "oven", "roaster-drum", "ring-light", "camera-tripod"]));
  });
  for (const o of targets) {
    it(`someone from the front of house reaches the ${o.kind} smoothly and stays to do it`, () => {
      const r = person("a-0");
      const room = roomOf.get(o.room)!;
      const at = new THREE.Vector3(room.x + o.at[0], room.y, room.z + o.at[1]);
      const gesture = world.kinds[o.kind]!.actions.find((a) => a.gesture !== "none")!.gesture as "pet" | "use";
      r.errand = { objectId: o.id ?? o.kind, gesture, until: 1000 + 60_000, spot: errandSpot(nav, o.room, at, gesture), arrived: false };
      const worst = run(r, 60, (now, dt) => {
        stepErrand(nav, r, now, dt, at);
        return !r.errand?.arrived;
      });
      expect(r.errand?.arrived).toBe(true);
      expect(worst).toBeLessThanOrEqual(1.1 / 60 + 1e-6);
      // In front of it: within reach of a cat, at the front edge of a long counter.
      expect(Math.hypot(r.obj.position.x - at.x, r.obj.position.z - at.z)).toBeLessThan(gesture === "pet" ? 1 : 1.6);
      // Then it goes back and sits down, walking all the way.
      r.errand = null;
      const back = run(r, 90, (now, dt) => {
        stepRoamer(nav, r, now, dt, true);
        return !r.seated;
      });
      expect(r.seated).toBe(true);
      expect(back).toBeLessThanOrEqual(1.1 / 60 + 1e-6);
    });
  }
});

describe("strolling about", () => {
  it("five minutes of roaming never jumps", () => {
    const r = person("a-1");
    r.allowed = new Set(nav.rooms.keys());
    expect(run(r, 300, (now, dt) => void stepRoamer(nav, r, now, dt, false))).toBeLessThanOrEqual(1.1 / 60 + 1e-6);
  });
  it("a slow frame still walks at walking speed, a long pause does not jump ahead", () => {
    const r = person("a-2");
    r.allowed = new Set(nav.rooms.keys());
    r.seated = false;
    r.path = [{ room: r.room, x: r.obj.position.x + 5, z: r.obj.position.z, y: r.obj.position.y }];
    const from = r.obj.position.x;
    stepRoamer(nav, r, 10_000, 0.4, false);
    expect(r.obj.position.x - from).toBeCloseTo(1.1 * 0.4, 5);
    stepRoamer(nav, r, 20_000, 10, false);
    expect(r.obj.position.x - from).toBeCloseTo(1.1 * 0.9, 5);
  });
});
