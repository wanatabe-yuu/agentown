import type { Look, Primitive } from "@agentown/core/world";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

/**
 * Meshes built from code: furniture, the built-in characters and objects
 * composed of primitives. Geometries are shared unit shapes scaled per mesh;
 * materials are shared per color and finish, except the ones a behavior or
 * state changes.
 */

type Finish = Primitive["finish"];
type Shape = Primitive["shape"];
const DEG = Math.PI / 180;
const unit: Record<Shape, THREE.BufferGeometry> = {
  box: new THREE.BoxGeometry(1, 1, 1),
  roundbox: new RoundedBoxGeometry(1, 1, 1, 3, 0.14),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 24),
  sphere: new THREE.SphereGeometry(0.5, 24, 16),
  cone: new THREE.ConeGeometry(0.5, 1, 24),
  torus: new THREE.TorusGeometry(0.4, 0.1, 12, 28),
  // Two half-sphere caps around a tube, 1 wide and 1 tall once mesh() halves its height.
  capsule: new THREE.CapsuleGeometry(0.5, 1, 8, 20),
};
const FINISH: Record<Finish, Partial<THREE.MeshPhysicalMaterialParameters>> = {
  matte: { roughness: 0.82, metalness: 0.02 },
  fabric: { roughness: 1, metalness: 0, sheen: 0.6, sheenRoughness: 0.8 },
  satin: { roughness: 0.5, metalness: 0.05, clearcoat: 0.2 },
  gloss: { roughness: 0.18, metalness: 0.05, clearcoat: 0.8, clearcoatRoughness: 0.15 },
  metal: { roughness: 0.28, metalness: 0.85 },
  glass: { roughness: 0.05, metalness: 0, transparent: true, opacity: 0.35, depthWrite: false },
};
const materials = new Map<string, THREE.MeshPhysicalMaterial>();

export function material(color: string, emissive?: string, own = false, finish: Finish = "matte"): THREE.MeshPhysicalMaterial {
  const key = `${color}|${emissive ?? ""}|${finish}`;
  if (!own && materials.has(key)) return materials.get(key)!;
  const m = new THREE.MeshPhysicalMaterial({ color, ...FINISH[finish], ...(emissive ? { emissive, emissiveIntensity: 0.9 } : {}) });
  if (!own) materials.set(key, m);
  return m;
}

function mesh(shape: Shape, size: [number, number, number], at: [number, number, number], mat: THREE.Material, rot: [number, number, number] = [0, 0, 0]) {
  const m = new THREE.Mesh(unit[shape], mat);
  m.scale.set(size[0], shape === "capsule" ? size[1] / 2 : size[1], size[2]);
  m.position.set(...at);
  m.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
  const see = !(mat as THREE.MeshPhysicalMaterial).transparent;
  m.castShadow = see;
  m.receiveShadow = true;
  return m;
}

/** An object made of primitives; named parts become named children so behaviors can move them. */
export function partsObject(parts: Primitive[]): THREE.Group {
  const g = new THREE.Group();
  for (const p of parts) {
    // Emissive parts get their own material: blink and flicker change its intensity.
    const m = mesh(p.shape, p.size, p.offset, material(p.color, p.emissive, !!p.emissive, p.finish ?? "matte"), p.rotation);
    if (p.part) {
      // Several primitives can share a part name: they move together.
      const existing = g.getObjectByName(p.part);
      if (existing && existing.parent === g && existing instanceof THREE.Group) {
        existing.add(m);
        continue;
      }
      const holder = new THREE.Group();
      holder.name = p.part;
      // The part turns around its first primitive's center.
      holder.position.copy(m.position);
      m.position.set(0, 0, 0);
      holder.add(m);
      g.add(holder);
      continue;
    }
    g.add(m);
  }
  // Later primitives of a part were placed in world space: make them relative to the holder.
  for (const c of g.children) {
    if (!(c instanceof THREE.Group)) continue;
    for (const m of c.children.slice(1)) m.position.sub(c.position);
  }
  return g;
}

const SKIN = ["#f1c9a5", "#e0ac84", "#c68b62", "#8d5a3b"];

/**
 * Built-in characters. Origin on the floor, facing -z (toward the desk).
 * People are drawn seated; animals sit on the chair, so they are lifted.
 * Named joints (head, arm-l/arm-r at the shoulders, leg-l/leg-r at the hips,
 * tail, eyes) are what the animations move. `variant` picks hair and skin.
 */
export function character(kind: "person" | "cat" | "dog" | "robot", color: string, accent = "#3b2a20", scale = 1, variant = 0): THREE.Group {
  const g = new THREE.Group();
  const body = material(color, undefined, false, kind === "robot" ? "satin" : "fabric");
  const dark = material(accent, undefined, false, "satin");
  const eye = material("#1b1b1f", undefined, false, "gloss");
  const joint = (name: string, at: [number, number, number], ...children: THREE.Object3D[]) => {
    const j = new THREE.Group();
    j.name = name;
    j.position.set(...at);
    j.add(...children);
    g.add(j);
    return j;
  };
  const eyes = (y: number, z: number, spread: number, size: number, mat = eye) => {
    const e = new THREE.Group();
    e.name = "eyes";
    e.add(mesh("sphere", [size, size * 1.15, size * 0.6], [-spread, 0, 0], mat), mesh("sphere", [size, size * 1.15, size * 0.6], [spread, 0, 0], mat));
    e.position.set(0, y, z);
    return e;
  };

  if (kind === "person") {
    const skin = material(SKIN[variant % SKIN.length]!, undefined, false, "satin");
    const shoe = material("#2a2522", undefined, false, "gloss");
    for (const [name, x] of [["leg-l", -0.1], ["leg-r", 0.1]] as const) {
      joint(name, [x, 0.52, 0], mesh("capsule", [0.15, 0.5, 0.15], [0, -0.24, 0], dark), mesh("roundbox", [0.14, 0.08, 0.22], [0, -0.5, -0.04], shoe));
    }
    g.add(mesh("capsule", [0.46, 0.64, 0.34], [0, 0.82, 0], body)); // torso
    g.add(mesh("cylinder", [0.12, 0.08, 0.12], [0, 1.12, 0], skin)); // neck
    const head = joint("head", [0, 1.28, 0], mesh("sphere", [0.34, 0.36, 0.33], [0, 0.02, 0], skin), eyes(0.04, -0.155, 0.065, 0.045));
    head.add(mesh("sphere", [0.06, 0.05, 0.05], [0, -0.03, -0.17], skin)); // nose
    // Hair: a cap plus a style.
    head.add(mesh("sphere", [0.36, 0.22, 0.35], [0, 0.12, 0.02], dark));
    const style = Math.floor(variant / SKIN.length) % 4;
    if (style === 1) head.add(mesh("sphere", [0.14, 0.14, 0.14], [0, 0.2, 0.15], dark)); // bun
    if (style === 2) head.add(mesh("roundbox", [0.38, 0.32, 0.12], [0, -0.04, 0.14], dark)); // long
    if (style === 3) for (const x of [-0.08, 0, 0.08]) head.add(mesh("cone", [0.08, 0.14, 0.08], [x, 0.26, 0], dark)); // spiky
    for (const [name, x] of [["arm-l", -0.27], ["arm-r", 0.27]] as const) {
      // Shoulder joints: an arm rotates around the top of itself.
      const arm = joint(name, [x, 1.02, 0], mesh("capsule", [0.12, 0.42, 0.12], [0, -0.2, 0], body), mesh("sphere", [0.1, 0.1, 0.1], [0, -0.42, 0], skin));
      arm.rotation.x = 35 * DEG;
    }
  } else if (kind === "robot") {
    const metal = material("#b8c2cc", undefined, false, "metal");
    const glow = material("#7df9ff", "#2ad4ff", true, "gloss");
    for (const [name, x] of [["leg-l", -0.11], ["leg-r", 0.11]] as const) {
      joint(name, [x, 0.52, 0], mesh("cylinder", [0.1, 0.46, 0.1], [0, -0.23, 0], metal), mesh("roundbox", [0.16, 0.08, 0.24], [0, -0.48, -0.03], dark));
    }
    g.add(mesh("roundbox", [0.48, 0.52, 0.34], [0, 0.8, 0], body));
    g.add(mesh("roundbox", [0.22, 0.14, 0.02], [0, 0.86, -0.175], glow)); // chest panel
    const head = joint("head", [0, 1.22, 0], mesh("roundbox", [0.38, 0.3, 0.32], [0, 0, 0], metal), mesh("roundbox", [0.3, 0.12, 0.02], [0, 0.02, -0.165], material("#14181f", undefined, false, "gloss")));
    head.add(eyes(0.02, -0.18, 0.07, 0.06, glow));
    head.add(mesh("cylinder", [0.03, 0.18, 0.03], [0, 0.24, 0], metal));
    const tip = mesh("sphere", [0.07, 0.07, 0.07], [0, 0.35, 0], material("#ff5a36", "#ff3b1f", true, "gloss"));
    tip.name = "antenna-tip";
    head.add(tip);
    for (const [name, x] of [["arm-l", -0.3], ["arm-r", 0.3]] as const) {
      const arm = joint(name, [x, 1.0, 0], mesh("cylinder", [0.08, 0.38, 0.08], [0, -0.19, 0], metal), mesh("roundbox", [0.12, 0.1, 0.12], [0, -0.4, 0], dark));
      arm.rotation.x = 35 * DEG;
    }
  } else {
    // A cat or a dog, sitting on the chair.
    const big = kind === "dog" ? 1.3 : 1;
    const lift = 0.47;
    // Animals are modelled sitting on the chair; walking drops them by this much.
    g.userData.lift = lift;
    const light = material(new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.45).getStyle(), undefined, false, "fabric");
    g.add(mesh("sphere", [0.36 * big, 0.4 * big, 0.46 * big], [0, lift + 0.2 * big, 0.04], body));
    g.add(mesh("sphere", [0.24 * big, 0.26 * big, 0.2 * big], [0, lift + 0.2 * big, -0.14 * big], light)); // chest
    for (const x of [-0.09, 0.09]) g.add(mesh("capsule", [0.09 * big, 0.12 * big, 0.12 * big], [x * big, lift + 0.03, -0.17 * big], light)); // front paws
    const head = joint("head", [0, lift + 0.46 * big, -0.12 * big], mesh("sphere", [0.28 * big, 0.25 * big, 0.25 * big], [0, 0, 0], body));
    head.add(mesh("sphere", [0.15 * big, 0.1 * big, 0.12 * big], [0, -0.05 * big, -0.1 * big], light)); // muzzle
    head.add(mesh("sphere", [0.04 * big, 0.03 * big, 0.03 * big], [0, -0.02 * big, -0.165 * big], material("#e58a9a", undefined, false, "gloss"))); // nose
    head.add(eyes(0.03 * big, -0.11 * big, 0.06 * big, 0.04 * big, kind === "cat" ? material("#9bd34a", undefined, false, "gloss") : eye));
    if (kind === "cat") {
      for (const [name, x] of [["ear-l", -0.08], ["ear-r", 0.08]] as const) {
        const ear = mesh("cone", [0.09, 0.14, 0.07], [x, 0.14, 0.01], body, [0, 0, x < 0 ? 12 : -12]);
        ear.name = name;
        head.add(ear);
      }
    } else {
      for (const [name, x] of [["ear-l", -0.13], ["ear-r", 0.13]] as const) {
        const ear = mesh("capsule", [0.07 * big, 0.2 * big, 0.08 * big], [x * big, -0.02, 0.02], dark, [0, 0, x < 0 ? 18 : -18]);
        ear.name = name;
        head.add(ear);
      }
    }
    const tail = new THREE.Group();
    tail.name = "tail";
    tail.position.set(0, lift + 0.08 * big, 0.26 * big);
    tail.add(mesh("capsule", [0.07 * big, (kind === "cat" ? 0.46 : 0.3) * big, 0.07 * big], [0, 0.18 * big, 0.06], kind === "cat" ? body : dark, [-30, 0, 0]));
    g.add(tail);
  }
  g.scale.setScalar(scale);
  return g;
}

/** Any object's look. Assets show as a plain block until they load. */
export function lookObject(look: Look, fallbackColor: string, variant = 0): THREE.Group {
  if ("character" in look) return character(look.character, look.color ?? fallbackColor, look.accent, look.scale, variant);
  if ("parts" in look) return partsObject(look.parts);
  const g = partsObject([{ shape: "box", size: [0.6, 0.6, 0.6], offset: [0, 0.3, 0], rotation: [0, 0, 0], color: "#9aa3ad", finish: "matte" }]);
  g.userData.asset = look.asset;
  g.userData.assetScale = look.scale;
  g.userData.assetRotationY = look.rotationY;
  return g;
}

/** A work desk: wooden top, a drawer block, a keyboard and a mug. */
export function desk(): THREE.Group {
  const g = new THREE.Group();
  const wood = material("#a47c55", undefined, false, "satin");
  const legs = material("#3a332d", undefined, false, "metal");
  g.add(mesh("roundbox", [1.4, 0.06, 0.7], [0, 0.74, 0], wood));
  g.add(mesh("roundbox", [0.36, 0.5, 0.6], [0.48, 0.46, 0], wood));
  g.add(mesh("box", [0.28, 0.02, 0.01], [0.48, 0.6, -0.301], legs));
  for (const [x, z] of [[-0.64, -0.29], [-0.64, 0.29]] as const) g.add(mesh("cylinder", [0.05, 0.72, 0.05], [x, 0.36, z], legs));
  g.add(mesh("roundbox", [0.44, 0.025, 0.14], [0, 0.785, 0.16], material("#2b2f36", undefined, false, "satin"))); // keyboard
  const mug = new THREE.Group();
  mug.name = "mug";
  mug.position.set(0.5, 0.82, 0.12);
  mug.add(mesh("cylinder", [0.08, 0.1, 0.08], [0, 0, 0], material("#f4efe6", undefined, false, "gloss")), mesh("torus", [0.07, 0.07, 0.07], [0.05, 0, 0], material("#f4efe6", undefined, false, "gloss"), [0, 90, 0]));
  g.add(mug);
  return g;
}

/** The monitor gets its own material: its color shows the runtime's state. */
export function monitor(): { group: THREE.Group; screen: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const frame = material("#22262c", undefined, false, "satin");
  const screen = new THREE.MeshStandardMaterial({ color: "#1d2733", emissive: "#000000", roughness: 0.35 });
  g.add(mesh("roundbox", [0.66, 0.42, 0.04], [0, 1.04, -0.18], frame));
  g.add(mesh("box", [0.6, 0.36, 0.01], [0, 1.04, -0.157], screen));
  g.add(mesh("cylinder", [0.05, 0.2, 0.05], [0, 0.86, -0.2], frame));
  g.add(mesh("roundbox", [0.24, 0.02, 0.16], [0, 0.775, -0.2], frame));
  return { group: g, screen };
}

/** An office chair on a five-star base. */
export function chair(): THREE.Group {
  const g = new THREE.Group();
  const seat = material("#3d4450", undefined, false, "fabric");
  const frame = material("#22262c", undefined, false, "metal");
  g.add(mesh("roundbox", [0.5, 0.09, 0.5], [0, 0.46, 0], seat));
  g.add(mesh("roundbox", [0.48, 0.52, 0.08], [0, 0.76, 0.23], seat));
  g.add(mesh("cylinder", [0.05, 0.36, 0.05], [0, 0.26, 0], frame));
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    g.add(mesh("box", [0.04, 0.03, 0.26], [Math.sin(a) * 0.12, 0.06, Math.cos(a) * 0.12], frame, [0, (a * 180) / Math.PI, 0]));
    g.add(mesh("sphere", [0.05, 0.05, 0.05], [Math.sin(a) * 0.25, 0.03, Math.cos(a) * 0.25], frame));
  }
  return g;
}

export function disposeMaterials() {
  for (const m of materials.values()) m.dispose();
  materials.clear();
}
