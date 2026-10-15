import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

/**
 * A soft studio room for reflections: without one, metal and gloss render
 * nearly black. Built once per renderer and set as the scene's environment.
 */
export function lightRoom(renderer: THREE.WebGLRenderer, scene: THREE.Scene, intensity = 0.55): () => void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = env;
  scene.environmentIntensity = intensity;
  pmrem.dispose();
  return () => env.dispose();
}
