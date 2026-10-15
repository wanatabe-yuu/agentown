import type { Primitive, World } from "@agentown/core/world";

/**
 * Edits to an object kind's look, as pure functions: the object panel calls
 * them and saves the kind, so every object of that kind changes together.
 */

type Kind = World["kinds"][string];
type Parts = Primitive[];

const parts = (k: Kind): Parts | null => ("parts" in k.look ? k.look.parts : null);
const withParts = (k: Kind, next: Parts): Kind => ({ ...k, look: { ...k.look, parts: next } as Kind["look"] });

/** Distinct plain colors of a parts look (glowing parts keep their own). */
export function kindColors(k: Kind, max = 8): string[] {
  return [...new Set((parts(k) ?? []).filter((x) => !x.emissive).map((x) => x.color.toLowerCase()))].slice(0, max);
}

/** Every part painted `from` becomes `to`. */
export function recolorKind(k: Kind, from: string, to: string): Kind {
  const ps = parts(k);
  if (!ps) return k;
  return withParts(k, ps.map((x) => (x.color.toLowerCase() === from.toLowerCase() ? { ...x, color: to } : x)));
}

export function updatePart(k: Kind, i: number, patch: Partial<Primitive>): Kind {
  const ps = parts(k);
  if (!ps?.[i]) return k;
  return withParts(k, ps.map((x, j) => (j === i ? { ...x, ...patch } : x)));
}

/** A new box next to the others, ready to be shaped. */
export function addPart(k: Kind): Kind {
  const ps = parts(k);
  if (!ps || ps.length >= 64) return k;
  return withParts(k, [...ps, { shape: "box", size: [0.3, 0.3, 0.3], offset: [0, 0.15, 0], rotation: [0, 0, 0], color: "#9aa3ad", finish: "matte" }]);
}

export function duplicatePart(k: Kind, i: number): Kind {
  const ps = parts(k);
  if (!ps?.[i] || ps.length >= 64) return k;
  const copy = { ...ps[i]!, offset: [ps[i]!.offset[0] + 0.1, ps[i]!.offset[1], ps[i]!.offset[2]] as Primitive["offset"] };
  return withParts(k, [...ps.slice(0, i + 1), copy, ...ps.slice(i + 1)]);
}

/** Removes a part; a look keeps at least one, and a part a behavior moves keeps its last piece. */
export function removePart(k: Kind, i: number): Kind {
  const ps = parts(k);
  if (!ps?.[i] || ps.length < 2) return k;
  const name = ps[i]!.part;
  if (name && k.behaviors.some((b) => b.part === name) && ps.filter((x) => x.part === name).length < 2) return k;
  return withParts(k, ps.filter((_, j) => j !== i));
}
