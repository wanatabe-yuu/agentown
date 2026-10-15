import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/addons/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/addons/utils/SkeletonUtils.js";
import { orgPath } from "../api.ts";

/**
 * Art from the organization's asset library. Each file is fetched once per
 * page (the server marks them immutable) and cloned per use. Until a model
 * arrives, or if it cannot load, its plain stand-in block stays.
 */

const models = new Map<string, Promise<GLTF>>();
const textures = new Map<string, THREE.Texture>();
const loader = new GLTFLoader();

const url = (id: string) => orgPath(`/api/assets/${encodeURIComponent(id)}`);

function model(id: string): Promise<GLTF> {
  if (!models.has(id)) models.set(id, loader.loadAsync(url(id)));
  return models.get(id)!;
}

/** A tiling texture for a floor or wall `w` × `h` meters, repeating every `every` meters. */
export function texture(id: string, w: number, h: number, every: number): THREE.Texture {
  if (!textures.has(id)) {
    const t = new THREE.TextureLoader().load(url(id));
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    textures.set(id, t);
  }
  const t = textures.get(id)!.clone();
  t.repeat.set(w / every, h / every);
  t.needsUpdate = true;
  return t;
}

/**
 * Swap every asset stand-in under `root` for its model. Models that carry
 * animations play their first clip (a turntable, a wagging tail).
 */
export function loadModels(root: THREE.Object3D, mixers: THREE.AnimationMixer[], alive: () => boolean) {
  const slots: THREE.Object3D[] = [];
  root.traverse((o) => {
    if (o.userData.asset) slots.push(o);
  });
  for (const slot of slots) {
    model(slot.userData.asset as string)
      .then((gltf) => {
        if (!alive()) return;
        const m = cloneSkinned(gltf.scene);
        m.traverse((x) => {
          if (x instanceof THREE.Mesh) {
            x.castShadow = true;
            x.receiveShadow = true;
          }
        });
        m.scale.multiplyScalar((slot.userData.assetScale as number) ?? 1);
        m.rotation.y = (((slot.userData.assetRotationY as number) ?? 0) * Math.PI) / 180;
        for (const c of [...slot.children]) if (c instanceof THREE.Mesh) slot.remove(c);
        slot.add(m);
        // Counted on the root, so a viewer can frame the real model once it arrives.
        root.userData.modelsLoaded = ((root.userData.modelsLoaded as number | undefined) ?? 0) + 1;
        if (gltf.animations[0]) {
          const mixer = new THREE.AnimationMixer(m);
          mixer.clipAction(gltf.animations[0]).play();
          mixers.push(mixer);
        }
      })
      .catch(() => {
        /* the stand-in stays: deleted asset, or not loadable */
      });
  }
}
