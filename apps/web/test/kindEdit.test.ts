import { readFileSync } from "node:fs";
import { parseTemplate, splitInstanceConfig } from "@agentown/core";
import { type World, worldSchema } from "@agentown/core/world";
import { describe, expect, it } from "vitest";
import { addPart, duplicatePart, kindColors, recolorKind, removePart, updatePart } from "../src/office3d/kindEdit.ts";

const { catalog } = splitInstanceConfig(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));
const world: World = worldSchema.parse(parseTemplate(readFileSync(new URL("../../../config/templates/coffee-store.yaml", import.meta.url), "utf8"), catalog).doc.world);
const table = world.kinds["cafe-table"]!;
const look = (k: World["kinds"][string]) => ("parts" in k.look ? k.look.parts : []);

describe("editing a kind from one object", () => {
  it("recolors every part of that color, and so every object of the kind", () => {
    const tables = world.objects.filter((o) => o.kind === "cafe-table");
    expect(tables.length).toBeGreaterThan(1);
    const marble = "#f1ece4";
    expect(kindColors(table)).toContain(marble);
    const next = recolorKind(table, marble, "#112233");
    const edited: World = { ...world, kinds: { ...world.kinds, "cafe-table": next } };
    // Objects hold a kind id, not a copy: all of them now draw the new color.
    for (const o of edited.objects.filter((x) => x.kind === "cafe-table")) expect(look(edited.kinds[o.kind]!).some((p) => p.color === "#112233")).toBe(true);
    expect(look(next).some((p) => p.color === marble)).toBe(false);
    // Other kinds and glowing parts are untouched.
    expect(edited.kinds.sofa).toBe(world.kinds.sofa);
    expect(worldSchema.safeParse(edited).success).toBe(true);
  });

  it("reshapes, adds, duplicates and removes parts, keeping what behaviors need", () => {
    const reshaped = updatePart(table, 0, { shape: "roundbox", size: [1, 0.06, 1], finish: "metal" });
    expect(look(reshaped)[0]).toMatchObject({ shape: "roundbox", size: [1, 0.06, 1], finish: "metal" });
    expect(look(addPart(table))).toHaveLength(look(table).length + 1);
    expect(look(duplicatePart(table, 1))[2]).toMatchObject({ shape: look(table)[1]!.shape, offset: [look(table)[1]!.offset[0] + 0.1, look(table)[1]!.offset[1], look(table)[1]!.offset[2]] });
    expect(look(removePart(table, 0))).toHaveLength(look(table).length - 1);
    // The steaming cup is the only "cup" part: it stays.
    const cup = look(table).findIndex((p) => p.part === "cup");
    expect(look(removePart(table, cup))).toHaveLength(look(table).length);
    const one = { ...table, look: { parts: [look(table)[0]!] } } as typeof table;
    expect(look(removePart(one, 0))).toHaveLength(1);
    expect(worldSchema.safeParse({ ...world, kinds: { ...world.kinds, "cafe-table": duplicatePart(addPart(reshaped), 0) } }).success).toBe(true);
  });
});
