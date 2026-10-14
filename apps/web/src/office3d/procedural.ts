import type { Look, Primitive } from "@agentown/core";
import * as THREE from "three";

/**
 * Meshes built from code: furniture, the built-in characters and objects
 * composed of primitives. Geometries are shared unit shapes scaled per mesh;
 * materials are shared per color, except the ones a behavior or state changes.
 */

const DEG = Math.PI / 180;
const unit = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 20),
  sphere: new THREE.SphereGeometry(0.5, 20, 14),
  cone: new THREE.ConeGeometry(0.5, 1, 20),
  torus: new THREE.TorusGeometry(0.4, 0.1, 10, 24),
};
const materials = new Map<string, THREE.MeshStandardMaterial>();

export function material(color: string, emissive?: string, own = false): THREE.MeshStandardMaterial {
  const key = `${color}|${emissive ?? ""}`;
  if (!own && materials.has(key)) return materials.get(key)!;
  const m = new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...(emissive ? { emissive, emissiveIntensity: 0.9 } : {}) });
  if (!own) materials.set(key, m);
  return m;
}

function mesh(shape: keyof typeof unit, size: [number, number, number], at: [number, number, number], mat: THREE.Material, rot: [number, number, number] = [0, 0, 0]) {
  const m = new THREE.Mesh(unit[shape], mat);
  m.scale.set(...size);
  m.position.set(...at);
  m.rotation.set(rot[0] * DEG, rot[1] * DEG, rot[2] * DEG);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** An object made of primitives; named parts become named children so behaviors can move them. */
export function partsObject(parts: Primitive[]): THREE.Group {
  const g = new THREE.Group();
  for (const p of parts) {
    // Emissive parts get their own material: blink changes its intensity.
    const m = mesh(p.shape, p.size, p.offset, material(p.color, p.emissive, !!p.emissive), p.rotation);
    if (p.part) m.name = p.part;
    g.add(m);
  }
  return g;
}

/**
 * Built-in characters. Origin on the floor, facing -z (toward the desk).
 * People are drawn seated; animals sit on the chair, so they are lifted.
 */
export function character(kind: "person" | "cat" | "dog" | "robot", color: string, accent = "#3b2a20", scale = 1): THREE.Group {
  const g = new THREE.Group();
  const body = material(color);
  const skin = material("#f1c9a5");
  const dark = material(accent);
  const add = (name: string, m: THREE.Mesh) => {
    m.name = name;
    g.add(m);
    return m;
  };
  if (kind === "person") {
    add("body", mesh("cylinder", [0.42, 0.55, 0.32], [0, 0.78, 0], body));
    add("head", mesh("sphere", [0.32, 0.34, 0.32], [0, 1.25, 0], skin));
    add("hair", mesh("sphere", [0.34, 0.2, 0.34], [0, 1.36, 0.02], dark));
    add("arm-l", mesh("cylinder", [0.1, 0.42, 0.1], [-0.26, 0.82, -0.12], body, [35, 0, 0]));
    add("arm-r", mesh("cylinder", [0.1, 0.42, 0.1], [0.26, 0.82, -0.12], body, [35, 0, 0]));
  } else if (kind === "robot") {
    const metal = material("#b8c2cc");
    add("body", mesh("box", [0.45, 0.5, 0.32], [0, 0.78, 0], body));
    add("head", mesh("box", [0.34, 0.28, 0.3], [0, 1.2, 0], metal));
    add("eye-l", mesh("sphere", [0.06, 0.06, 0.04], [-0.07, 1.22, -0.15], material("#7df9ff", "#2ad4ff")));
    add("eye-r", mesh("sphere", [0.06, 0.06, 0.04], [0.07, 1.22, -0.15], material("#7df9ff", "#2ad4ff")));
    add("antenna", mesh("cylinder", [0.03, 0.2, 0.03], [0, 1.44, 0], metal));
    add("arm-l", mesh("box", [0.08, 0.38, 0.08], [-0.28, 0.8, -0.1], metal, [35, 0, 0]));
    add("arm-r", mesh("box", [0.08, 0.38, 0.08], [0.28, 0.8, -0.1], metal, [35, 0, 0]));
  } else {
    // A cat or a dog, sitting on the chair: body, head, ears, tail.
    const big = kind === "dog" ? 1.35 : 1;
    const lift = 0.47;
    add("body", mesh("sphere", [0.34 * big, 0.36 * big, 0.42 * big], [0, lift + 0.18 * big, 0.04], body));
    add("head", mesh("sphere", [0.26 * big, 0.24 * big, 0.24 * big], [0, lift + 0.42 * big, -0.12 * big], body));
    if (kind === "cat") {
      add("ear-l", mesh("cone", [0.08, 0.12, 0.08], [-0.07, lift + 0.56, -0.12], body));
      add("ear-r", mesh("cone", [0.08, 0.12, 0.08], [0.07, lift + 0.56, -0.12], body));
    } else {
      add("ear-l", mesh("sphere", [0.08, 0.16, 0.06], [-0.13 * big, lift + 0.44 * big, -0.1 * big], dark));
      add("ear-r", mesh("sphere", [0.08, 0.16, 0.06], [0.13 * big, lift + 0.44 * big, -0.1 * big], dark));
      add("nose", mesh("sphere", [0.12, 0.1, 0.14], [0, lift + 0.38 * big, -0.26 * big], body));
    }
    const tail = new THREE.Group();
    tail.name = "tail";
    tail.position.set(0, lift + 0.12 * big, 0.24 * big);
    tail.add(mesh("cylinder", [0.05 * big, 0.36 * big, 0.05 * big], [0, 0.15 * big, 0.05], dark, [-25, 0, 0]));
    g.add(tail);
  }
  g.scale.setScalar(scale);
  return g;
}

/** Any object's look. Assets (Phase 4) show as a plain block until they load. */
export function lookObject(look: Look, fallbackColor: string): THREE.Group {
  if ("character" in look) return character(look.character, look.color ?? fallbackColor, look.accent, look.scale);
  if ("parts" in look) return partsObject(look.parts);
  const g = partsObject([{ shape: "box", size: [0.6, 0.6, 0.6], offset: [0, 0.3, 0], rotation: [0, 0, 0], color: "#9aa3ad" }]);
  g.userData.asset = look.asset;
  return g;
}

export function desk(): THREE.Group {
  const g = new THREE.Group();
  const wood = material("#9b7653");
  const leg = material("#5c4a3a");
  g.add(mesh("box", [1.4, 0.06, 0.7], [0, 0.74, 0], wood));
  for (const [x, z] of [[-0.62, -0.28], [0.62, -0.28], [-0.62, 0.28], [0.62, 0.28]] as const) g.add(mesh("box", [0.05, 0.72, 0.05], [x, 0.36, z], leg));
  return g;
}

/** The monitor gets its own material: its color shows the runtime's state. */
export function monitor(): { group: THREE.Group; screen: THREE.MeshStandardMaterial } {
  const g = new THREE.Group();
  const frame = material("#2b2f36");
  const screen = new THREE.MeshStandardMaterial({ color: "#1d2733", emissive: "#000000", roughness: 0.4 });
  g.add(mesh("box", [0.62, 0.4, 0.04], [0, 1.02, -0.18], frame));
  const s = mesh("box", [0.56, 0.34, 0.01], [0, 1.02, -0.155], screen);
  g.add(s);
  g.add(mesh("box", [0.06, 0.2, 0.06], [0, 0.85, -0.2], frame));
  return { group: g, screen };
}

export function chair(): THREE.Group {
  const g = new THREE.Group();
  const seat = material("#3d4450");
  g.add(mesh("box", [0.48, 0.07, 0.48], [0, 0.45, 0], seat));
  g.add(mesh("box", [0.48, 0.5, 0.06], [0, 0.72, 0.22], seat));
  g.add(mesh("cylinder", [0.06, 0.42, 0.06], [0, 0.21, 0], material("#22262c")));
  return g;
}

export function disposeMaterials() {
  for (const m of materials.values()) m.dispose();
  materials.clear();
}
