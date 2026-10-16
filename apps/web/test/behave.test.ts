import { readFileSync } from "node:fs";
import { parseTemplate, splitInstanceConfig } from "@agentown/core";
import { worldSchema } from "@agentown/core/world";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { applyBehavior, prepareBehaviors } from "../src/office3d/behave.ts";
import { lookObject } from "../src/office3d/procedural.ts";
import { animateAvatar } from "../src/office3d/scene.ts";

const { catalog } = splitInstanceConfig(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));
const world = worldSchema.parse(parseTemplate(readFileSync(new URL("../../../apps/server/test/fixtures/templates/coffee-store.yaml", import.meta.url), "utf8"), catalog).doc.world);

/** Everything a behavior can change on its target, as one comparable string. */
function state(o: THREE.Object3D): string {
  const out: number[] = [];
  o.traverse((x) => {
    out.push(...x.position.toArray(), x.rotation.x, x.rotation.y, x.rotation.z, ...x.scale.toArray());
    const m = (x as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m?.emissiveIntensity !== undefined) out.push(m.emissiveIntensity);
  });
  return out.map((n) => n.toFixed(4)).join(",");
}

describe("coffee template animations", () => {
  const animatedKinds = Object.entries(world.kinds).filter(([, k]) => k.behaviors.some((b) => b.type !== "roam"));

  it("has plenty of moving things", () => {
    expect(animatedKinds.map(([id]) => id)).toEqual(expect.arrayContaining(["espresso-station", "roaster-drum", "jukebox", "ceiling-fan", "oven", "umbrella-table", "lantern", "pendant-lamp", "cafe-table", "plant"]));
  });

  for (const [id, kind] of animatedKinds) {
    it(`${id}: every behavior moves its part over time`, () => {
      const obj = lookObject(kind.look, "#888888");
      const root = new THREE.Group().add(obj);
      root.updateMatrixWorld(true);
      const anims = prepareBehaviors(obj, kind, 0, null);
      expect(anims).toHaveLength(kind.behaviors.filter((b) => b.type !== "roam").length);
      for (const an of anims) {
        // A named part must exist: otherwise the behavior would move the whole object by mistake.
        if (an.behavior.part && an.behavior.type !== "wander") expect(an.target, `${id}: part ${an.behavior.part}`).not.toBe(obj);
        if (an.behavior.type === "steam") expect(an.puffs?.length).toBeGreaterThan(0);
        const at = (sec: number) => {
          applyBehavior(an, sec);
          return state(an.target);
        };
        const frames = new Set([at(0.1), at(0.37), at(0.81), at(1.53), at(2.2)]);
        expect(frames.size, `${id}: ${an.behavior.type} on ${an.behavior.part ?? "whole"}`).toBeGreaterThan(1);
      }
    });
  }

  it("characters act out their work", () => {
    const person = lookObject(world.kinds.barista!.look, "#888888", 5);
    const pose = (work: string, walking = false) => {
      animateAvatar(person, work, 1.3, 0, walking);
      return ["head", "arm-l", "arm-r"].map((n) => person.getObjectByName(n)!.rotation.toArray().slice(0, 3).map((v) => Number(v).toFixed(2)).join()).join("|");
    };
    const poses = new Set([pose("idle"), pose("thinking"), pose("executing"), pose("blocked"), pose("waiting"), pose("idle", true)]);
    expect(poses.size).toBe(6);
  });
});

describe("data-driven shapes and motion", () => {
  const kind = (k: unknown) => worldSchema.parse({ floors: [{ id: "f", name: "F", rooms: [{ id: "r", name: "R", area: { x: 0, z: 0, w: 4, d: 4 } }] }], kinds: { k } }).kinds.k!;

  it("extrude and lathe outlines become parts stretched to their size", () => {
    const k = kind({ name: "Vase", category: "static", look: { parts: [
      { shape: "lathe", points: [[0, 0], [0.4, 0.1], [0.2, 0.8], [0.3, 1]], size: [0.3, 0.5, 0.3], opacity: 0.6, roughness: 0.2 },
      { shape: "extrude", points: [[0, 0], [1, 0], [0.5, 1]], size: [0.4, 0.4, 0.05], offset: [0, 0.8, 0] },
    ] } });
    const o = lookObject(k.look, "#888");
    const box = new THREE.Box3().setFromObject(o).getSize(new THREE.Vector3());
    expect(box.y).toBeCloseTo(0.75, 2); // lathe 0.25–0.75, extrude 0.6–1.0
    expect(((o.children[0] as THREE.Mesh).material as THREE.Material).transparent).toBe(true);
    expect(() => kind({ name: "Bad", category: "static", look: { parts: [{ shape: "extrude", points: [[0, 0], [1, 1]] }] } })).toThrow(/3 points/);
  });

  it("keyframes loop through their poses, eased, back to the start", () => {
    const k = kind({ name: "Bird", category: "dynamic", look: { parts: [{ shape: "sphere" }] }, behaviors: [{ type: "keyframes", speed: 1, keys: [{ t: 0 }, { t: 0.5, position: [0, 1, 0], rotation: [0, 90, 0] }] }] });
    const o = lookObject(k.look, "#888");
    const [an] = prepareBehaviors(o, k, 0, null);
    applyBehavior(an!, 0.5);
    expect(o.position.y).toBeCloseTo(1, 5);
    expect(o.rotation.y).toBeCloseTo(Math.PI / 2, 5);
    applyBehavior(an!, 0.25);
    expect(o.position.y).toBeCloseTo(0.5, 5);
    applyBehavior(an!, 1);
    expect(o.position.y).toBeCloseTo(0, 5);
  });
});
