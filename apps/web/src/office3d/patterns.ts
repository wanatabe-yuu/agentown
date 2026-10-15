import * as THREE from "three";

/**
 * Floor and wall patterns drawn on a canvas in the room's own color, so a
 * template gets wood floors or brick walls without uploading any image.
 * One canvas covers TILE meters; textures repeat it across the room.
 */

export const TILE = 2;
const PX = 512;
const cache = new Map<string, HTMLCanvasElement>();

const shade = (hex: string, amount: number) => {
  const c = new THREE.Color(hex);
  return (amount < 0 ? c.lerp(new THREE.Color("#000000"), -amount) : c.lerp(new THREE.Color("#ffffff"), amount)).getStyle();
};
// Seeded noise, so the same room always looks the same.
const rand = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

function draw(style: string, color: string): HTMLCanvasElement {
  const key = `${style}|${color}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement("canvas");
  c.width = c.height = PX;
  const g = c.getContext("2d")!;
  const r = rand(style.length * 97 + parseInt(color.slice(1), 16) % 9973);
  const m = PX / TILE; // pixels per meter
  g.fillStyle = color;
  g.fillRect(0, 0, PX, PX);
  switch (style) {
    case "wood":
    case "deck": {
      const plank = (style === "deck" ? 0.14 : 0.18) * m;
      for (let y = 0; y < PX; y += plank) {
        let x = -r() * PX;
        while (x < PX) {
          const len = (0.9 + r() * 1.2) * m;
          g.fillStyle = shade(color, (r() - 0.5) * 0.16);
          g.fillRect(x, y, len, plank);
          // Grain.
          g.strokeStyle = shade(color, -0.12);
          g.globalAlpha = 0.25;
          for (let k = 0; k < 3; k++) {
            g.beginPath();
            const gy = y + plank * (0.25 + k * 0.25) + (r() - 0.5) * 3;
            g.moveTo(x, gy);
            g.bezierCurveTo(x + len * 0.3, gy + 2, x + len * 0.6, gy - 2, x + len, gy);
            g.stroke();
          }
          g.globalAlpha = 1;
          g.fillStyle = shade(color, -0.35);
          g.fillRect(x, y, 1.5, plank);
          x += len;
        }
        g.fillStyle = shade(color, style === "deck" ? -0.55 : -0.3);
        g.fillRect(0, y, PX, style === "deck" ? 4 : 1.5);
      }
      break;
    }
    case "tile":
    case "checker": {
      const n = style === "tile" ? 4 : 5;
      const s = PX / n;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          g.fillStyle = style === "checker" ? ((i + j) % 2 ? shade(color, -0.55) : shade(color, 0.25)) : shade(color, (r() - 0.5) * 0.08);
          g.fillRect(i * s, j * s, s, s);
        }
      }
      g.strokeStyle = shade(color, style === "tile" ? 0.35 : -0.2);
      g.lineWidth = 3;
      for (let i = 0; i <= n; i++) {
        g.beginPath();
        g.moveTo(i * s, 0);
        g.lineTo(i * s, PX);
        g.moveTo(0, i * s);
        g.lineTo(PX, i * s);
        g.stroke();
      }
      break;
    }
    case "concrete":
      for (let k = 0; k < 2600; k++) {
        g.fillStyle = shade(color, (r() - 0.5) * 0.25);
        g.globalAlpha = 0.5;
        g.fillRect(r() * PX, r() * PX, 1 + r() * 3, 1 + r() * 3);
      }
      g.globalAlpha = 1;
      break;
    case "brick": {
      const h = 0.075 * m;
      const w = 0.24 * m;
      for (let row = 0, y = 0; y < PX; row++, y += h) {
        for (let x = row % 2 ? -w / 2 : 0; x < PX; x += w) {
          g.fillStyle = shade(color, (r() - 0.5) * 0.22);
          g.fillRect(x + 1.5, y + 1.5, w - 3, h - 3);
        }
      }
      g.globalCompositeOperation = "destination-over";
      g.fillStyle = shade(color, 0.45);
      g.fillRect(0, 0, PX, PX);
      g.globalCompositeOperation = "source-over";
      break;
    }
    case "panel": {
      // Wainscoting on the lower half, a rail, plain paint above.
      g.fillStyle = shade(color, 0.3);
      g.fillRect(0, 0, PX, PX / 2);
      g.fillStyle = shade(color, -0.1);
      g.fillRect(0, PX / 2, PX, PX / 2);
      g.fillStyle = shade(color, -0.3);
      g.fillRect(0, PX / 2 - 6, PX, 10);
      g.strokeStyle = shade(color, -0.25);
      g.lineWidth = 4;
      for (let x = 12; x < PX; x += PX / 4) g.strokeRect(x, PX / 2 + 24, PX / 4 - 24, PX / 2 - 48);
      break;
    }
    case "stripe":
      for (let x = 0; x < PX; x += 64) {
        g.fillStyle = shade(color, 0.12);
        g.fillRect(x, 0, 32, PX);
      }
      break;
  }
  cache.set(key, c);
  return c;
}

/** A repeating texture for a w × h meter surface, or null for a plain one. */
export function pattern(style: string | null | undefined, color: string, w: number, h: number): THREE.Texture | null {
  if (!style || style === "plain") return null;
  const t = new THREE.CanvasTexture(draw(style, color));
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  t.repeat.set(w / TILE, h / TILE);
  return t;
}
