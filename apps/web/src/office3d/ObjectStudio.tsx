import type { World } from "@agentown/core/world";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { t } from "../i18n.ts";
import { loadModels } from "./assets.ts";
import { lightRoom } from "./env.ts";
import { applyBehavior, prepareBehaviors } from "./behave.ts";
import { lookObject } from "./procedural.ts";
import { animateAvatar, swingLegs } from "./scene.ts";

type Kind = World["kinds"][string];

/**
 * One placed object on its own: the same model as in the office, doing what
 * its behaviors make it do (spinning, steaming, glowing), framed to its size.
 * Drag sideways to turn it. A character (the shop cat) can be shown walking.
 */
export default function ObjectStudio(p: { kind: Kind; scale: number; walking?: boolean; /** Outline this part (index into the look's parts). */ highlight?: number | null }) {
  const wrap = useRef<HTMLDivElement>(null);
  const stage = useRef<{ holder: THREE.Group; fit: () => void } | null>(null);
  const walking = useRef(!!p.walking);
  walking.current = !!p.walking;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = wrap.current!;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    el.prepend(renderer.domElement);
    const scene = new THREE.Scene();
    const dropEnv = lightRoom(renderer, scene);
    scene.add(new THREE.HemisphereLight("#f4f1ff", "#a0846a", 1.3));
    const sun = new THREE.DirectionalLight("#fff1dc", 1.9);
    sun.position.set(3, 6, 4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.radius = 4;
    scene.add(sun);
    const floorGeo = new THREE.CircleGeometry(1, 64);
    const floorMat = new THREE.MeshStandardMaterial({ color: "#b8b1a5", roughness: 0.9 });
    const floor = new THREE.Mesh(floorGeo, floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const holder = new THREE.Group();
    scene.add(holder);

    const camera = new THREE.PerspectiveCamera(35, 1, 0.05, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableZoom = false;
    controls.enableDamping = true;
    renderer.domElement.style.touchAction = "pan-y";

    let w = 1;
    let h = 1;
    // Frame whatever is on the stage: a cup or a whole counter.
    const fit = () => {
      const box = new THREE.Box3().setFromObject(holder);
      if (box.isEmpty()) return;
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const r = Math.max(0.35, sphere.radius);
      floor.scale.setScalar(r * 1.6);
      sun.shadow.camera.left = sun.shadow.camera.bottom = -r * 2;
      sun.shadow.camera.right = sun.shadow.camera.top = r * 2;
      sun.shadow.camera.updateProjectionMatrix();
      const vfov = (camera.fov * Math.PI) / 180;
      const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
      const dist = (r * 1.15) / Math.sin(Math.min(vfov, hfov) / 2);
      controls.target.copy(sphere.center);
      camera.position.copy(sphere.center).add(new THREE.Vector3(0.75, 0.55, 1).normalize().multiplyScalar(dist));
      camera.near = dist / 50;
      camera.far = dist * 10;
      camera.updateProjectionMatrix();
      controls.update();
      controls.minPolarAngle = controls.maxPolarAngle = controls.getPolarAngle();
    };
    stage.current = { holder, fit };
    const size = () => {
      w = Math.max(1, el.clientWidth);
      h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      fit();
    };
    const ro = new ResizeObserver(size);
    ro.observe(el);
    size();

    let frame = 0;
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      const sec = now / 1000;
      for (const an of (holder.userData.animated as ReturnType<typeof prepareBehaviors> | undefined) ?? []) applyBehavior(an, sec);
      for (const c of holder.children) if (c instanceof THREE.BoxHelper) c.update();
      const body = holder.children[0];
      if (body?.userData.character) {
        const lift = ((body.userData.lift as number | undefined) ?? 0) * body.scale.y;
        animateAvatar(body, "idle", sec, walking.current ? -lift : 0, walking.current);
        swingLegs(body, walking.current ? Math.sin(sec * 9) * 0.6 : 0);
      }
      controls.update();
      renderer.render(scene, camera);
    };
    frame = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      floorGeo.dispose();
      floorMat.dispose();
      dropEnv();
      renderer.dispose();
      // Give the context back now: browsers keep only a few, and the office needs its own.
      renderer.forceContextLoss();
      renderer.domElement.remove();
      stage.current = null;
    };
  }, []);

  // The model itself, rebuilt when its look or placement changes (edits preview right away).
  const key = JSON.stringify([p.kind.look, p.kind.behaviors, p.scale, p.highlight]);
  useEffect(() => {
    const s = stage.current;
    if (!s) return;
    s.holder.clear();
    const obj = lookObject(p.kind.look, "#9aa3ad");
    obj.userData.character = "character" in p.kind.look;
    // Characters are built facing their desk (−z); turn them to face the viewer.
    if (obj.userData.character) obj.rotation.y = Math.PI;
    // Shown from the front, whichever way it is turned in its room.
    obj.scale.multiplyScalar(p.scale);
    s.holder.add(obj);
    s.holder.updateMatrixWorld(true);
    s.holder.userData.animated = prepareBehaviors(obj, p.kind, 0, null);
    if (p.highlight != null) {
      let hit: THREE.Object3D | undefined;
      obj.traverse((m) => {
        if (m.userData.partIndex === p.highlight) hit = m;
      });
      if (hit) s.holder.add(new THREE.BoxHelper(hit, getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c0773a"));
    }
    let alive = true;
    loadModels(s.holder, [], () => alive);
    s.fit();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <div className="studio-stage object-stage" ref={wrap}>
      {failed && <p className="muted small studio-fallback">{t("The 3D office cannot start in this browser.")}</p>}
    </div>
  );
}
