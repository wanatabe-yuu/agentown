import type { Behavior, World } from "@agentown/core/world";
import * as THREE from "three";

/**
 * Behaviors from the template, applied each frame: shared by the office and
 * the studio (where an object is looked at on its own).
 */

const TAU = Math.PI * 2;

export interface Animated {
  target: THREE.Object3D;
  behavior: Behavior;
  base: { position: THREE.Vector3; rotation: THREE.Euler; scale: THREE.Vector3 };
  materials: THREE.MeshStandardMaterial[];
  /** Wander stays inside this rectangle (absolute meters); null: around where it stands. */
  room: { x: number; z: number; w: number; d: number } | null;
  seed: number;
  puffs?: THREE.Mesh[];
}

const puffGeo = new THREE.SphereGeometry(0.5, 10, 8);
// A faint glow of its own keeps steam readable against dark rooms too.
const puffMat = new THREE.MeshStandardMaterial({ color: "#ffffff", emissive: "#ffffff", emissiveIntensity: 0.25, transparent: true, opacity: 0.5, depthWrite: false, roughness: 1 });

/** Everything but roam (which walks between rooms) for one placed object. */
export function prepareBehaviors(obj: THREE.Object3D, kind: World["kinds"][string], seed: number, room: Animated["room"]): Animated[] {
  const out: Animated[] = [];
  for (const b of kind.behaviors.filter((x) => x.type !== "roam")) {
    // Wander moves the whole object around the room; other behaviors may target one part.
    const target = b.part && b.type !== "wander" ? (obj.getObjectByName(b.part) ?? obj) : obj;
    const materials: THREE.MeshStandardMaterial[] = [];
    target.traverse((m) => {
      // Only glowing parts blink (they own their material); plain shared materials are left alone.
      const mat = m instanceof THREE.Mesh ? (m.material as THREE.MeshStandardMaterial) : null;
      if (mat?.emissive && mat.emissive.getHex() !== 0) materials.push(mat);
    });
    const an: Animated = { target, behavior: b, base: { position: target.position.clone(), rotation: target.rotation.clone(), scale: target.scale.clone() }, materials, room, seed };
    if (b.type === "steam") {
      // Little clouds rising from the top of the part.
      const box = new THREE.Box3().setFromObject(target);
      const top = target.worldToLocal(new THREE.Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2));
      an.puffs = [];
      for (let i = 0; i < 5; i++) {
        const p = new THREE.Mesh(puffGeo, puffMat);
        p.position.copy(top);
        p.userData.base = top.clone();
        p.castShadow = false;
        target.add(p);
        an.puffs.push(p);
      }
    }
    out.push(an);
  }
  return out;
}

export function applyBehavior(an: Animated, sec: number) {
  const { target: o, behavior: b, base } = an;
  const phase = sec * b.speed * TAU + an.seed;
  switch (b.type) {
    case "spin": {
      const ax = b.axis ?? "y";
      o.rotation[ax] = base.rotation[ax] + sec * b.speed * TAU * b.amount;
      break;
    }
    case "bob":
      o.position.y = base.position.y + Math.sin(phase) * 0.08 * b.amount;
      break;
    case "sway": {
      const ax = b.axis ?? "z";
      o.rotation[ax] = base.rotation[ax] + Math.sin(phase) * 0.15 * b.amount;
      break;
    }
    case "rock": {
      const ax = b.axis ?? "x";
      o.rotation[ax] = base.rotation[ax] + Math.sin(phase) * 0.12 * b.amount;
      break;
    }
    case "pulse":
      o.scale.copy(base.scale).multiplyScalar(1 + Math.sin(phase) * 0.08 * b.amount);
      break;
    case "blink":
      for (const m of an.materials) m.emissiveIntensity = 0.5 + 0.5 * Math.sin(phase) * b.amount;
      break;
    case "flicker": {
      // A warm lamp: mostly steady, now and then a soft dip.
      const n = Math.sin(phase * 1.7) * Math.sin(phase * 2.9 + 1.3) * Math.sin(phase * 0.37);
      for (const m of an.materials) m.emissiveIntensity = 0.85 + 0.25 * n * b.amount;
      break;
    }
    case "steam":
      for (const [i, p] of (an.puffs ?? []).entries()) {
        const k = (sec * b.speed * 0.6 + i / an.puffs!.length + an.seed) % 1;
        const bp = p.userData.base as THREE.Vector3;
        p.position.set(bp.x + Math.sin((k + i) * 5) * 0.04, bp.y + k * 0.5 * b.amount, bp.z);
        p.scale.setScalar((0.07 + k * 0.16) * Math.sin(Math.PI * k) * b.amount + 0.001);
      }
      break;
    case "wander": {
      // A smooth, seeded stroll around where it was placed, staying inside the room.
      const k = sec * b.speed * 0.25;
      const x = base.position.x + (Math.sin(k + an.seed) + Math.sin(k * 0.61 + an.seed * 2)) * 0.5 * b.amount;
      const z = base.position.z + (Math.cos(k * 0.83 + an.seed) + Math.sin(k * 0.47 + an.seed * 3)) * 0.5 * b.amount;
      const r = an.room;
      const nx = r ? Math.min(r.x + r.w - 0.4, Math.max(r.x + 0.4, x)) : x;
      const nz = r ? Math.min(r.z + r.d - 0.4, Math.max(r.z + 0.4, z)) : z;
      const dx = nx - o.position.x;
      const dz = nz - o.position.z;
      if (dx * dx + dz * dz > 1e-6) o.rotation.y = Math.atan2(-dx, -dz);
      o.position.x = nx;
      o.position.z = nz;
      break;
    }
  }
}
