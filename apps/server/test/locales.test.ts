import { describe, expect, it } from "vitest";
import { DICTS, translateNames } from "../src/locales.ts";

describe("template language", () => {
  const doc = { departments: [{ id: "bar", name: "Coffee bar" }, { id: "x", name: "My own name" }], world: { floors: [{ id: "f1", name: "Floor 1", rooms: [{ id: "k", name: "1C · Kitchen" }] }] } };
  it("translates template names and leaves ids and custom names alone", () => {
    const vi = translateNames(doc, "en", "vi");
    expect(vi.departments).toEqual([{ id: "bar", name: "Quầy pha chế" }, { id: "x", name: "My own name" }]);
    expect(vi.world.floors[0]!.name).toBe("Tầng 1");
    expect(vi.world.floors[0]!.rooms[0]!.name).toBe("1C · Bếp");
    expect(translateNames(vi, "vi", "en")).toEqual(doc);
  });
  it("every translation maps back to one English name", () => {
    const names = Object.keys(DICTS.vi).map((name) => ({ name }));
    expect(translateNames(translateNames(names, "en", "vi"), "vi", "en")).toEqual(names);
  });
});
