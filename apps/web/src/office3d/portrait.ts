import * as THREE from "three";
import { loadModels } from "./assets.ts";
import { lightRoom } from "./env.ts";

/**
 * Small pictures of people and things, taken from their 3D models: the face
 * avatar in chats and on the 2D map when nobody uploaded one. One hidden
 * renderer takes them all, one at a time, and each picture is kept for the page.
 */

const SIZE = 192;
const cache = new Map<string, Promise<string>>();
let stage: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera } | null = null;
let queue: Promise<unknown> = Promise.resolve();

function setup() {
  if (stage) return stage;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setSize(SIZE, SIZE, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  lightRoom(renderer, scene);
  scene.add(new THREE.HemisphereLight("#f4f1ff", "#a0846a", 1.4));
  const key = new THREE.DirectionalLight("#fff1dc", 1.8);
  key.position.set(2, 3, 4);
  scene.add(key);
  stage = { renderer, scene, camera: new THREE.PerspectiveCamera(28, 1, 0.01, 100) };
  return stage;
}

/**
 * A picture of `build()`, cached by `key`. `face` frames a character's head
 * and shoulders; otherwise the whole thing from a three-quarter view.
 */
export function portrait(key: string, build: () => THREE.Object3D, face: boolean): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;
  const job: Promise<string> = queue.then(async () => {
    let s;
    try {
      s = setup();
    } catch {
      return "";
    }
    const holder = new THREE.Group();
    const obj = build();
    // Characters are built facing their desk (−z): turn them to the camera.
    if (face) obj.rotation.y += Math.PI;
    holder.add(obj);
    s.scene.add(holder);
    // A model from the library arrives after its stand-in: give it a moment.
    let slots = 0;
    obj.traverse((o) => void (o.userData.asset && slots++));
    if (slots) {
      loadModels(holder, [], () => true);
      for (let i = 0; i < 40 && ((holder.userData.modelsLoaded as number | undefined) ?? 0) < slots; i++) await new Promise((r) => setTimeout(r, 100));
    }
    holder.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    if (face) {
      // Head and shoulders: the top third of the body.
      center.y = box.max.y - size.y * 0.24;
      const r = Math.max(size.y * 0.24, size.x * 0.32, 0.12);
      s.camera.position.set(center.x, center.y + r * 0.15, center.z + r / Math.tan((s.camera.fov * Math.PI) / 360));
    } else {
      const r = Math.max(0.1, box.getBoundingSphere(new THREE.Sphere()).radius);
      s.camera.position.copy(center).add(new THREE.Vector3(0.7, 0.55, 1).normalize().multiplyScalar((r * 1.08) / Math.sin((s.camera.fov * Math.PI) / 360)));
    }
    s.camera.near = 0.01;
    s.camera.far = 200;
    s.camera.lookAt(center);
    s.camera.updateProjectionMatrix();
    s.renderer.render(s.scene, s.camera);
    const url = s.renderer.domElement.toDataURL("image/png");
    s.scene.remove(holder);
    return url;
  });
  queue = job.catch(() => "");
  cache.set(key, job);
  return job;
}

/** Portraits of an agent and of a placed object, as the office draws them. */
export async function agentPortrait(a: { id: string; jobRole: string }, world: import("@agentown/core/world").World | null, color: string) {
  const { agentAvatar } = await import("./scene.ts");
  const own = world?.avatars.byAgent?.[a.id];
  const kindId = own?.kind ?? world?.avatars.byJobRole[a.jobRole] ?? world?.avatars.default;
  const look = kindId ? world?.kinds[kindId]?.look : undefined;
  const face = !look || "character" in look;
  return portrait(`agent:${a.id}:${a.jobRole}:${color}:${JSON.stringify([own, look])}`, () => agentAvatar(a, world, color).avatar, face);
}
export async function lookPortrait(look: import("@agentown/core/world").Look) {
  const { lookObject } = await import("./procedural.ts");
  return portrait(`look:${JSON.stringify(look)}`, () => lookObject(look, "#9aa3ad"), "character" in look);
}
