import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTemplate, splitInstanceConfig } from "../src/index.ts";

const { catalog } = splitInstanceConfig(readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8"));
const coffee = readFileSync(new URL("../../../config/templates/coffee-store.yaml", import.meta.url), "utf8");

describe("world in a template", () => {
  it("the coffee store has floors, rooms, characters and moving things", () => {
    const { doc } = parseTemplate(coffee, catalog);
    const world = doc.world as { floors: Array<{ rooms: unknown[] }>; kinds: Record<string, { category: string }> };
    expect(world.floors.map((f) => f.rooms.length)).toEqual([4, 3]);
    expect(Object.values(world.kinds).map((k) => k.category)).toEqual(expect.arrayContaining(["character", "static", "dynamic"]));
  });

  it("rejects references that do not exist and avatars that are not characters", () => {
    const broken = (from: string, to: string) => () => parseTemplate(coffee.replace(from, to), catalog);
    expect(broken("department: kitchen, area", "department: nowhere, area")).toThrow(/unknown department nowhere/);
    expect(broken("{ kind: oven, room: 1c, at: [8.5, 1] }", "{ kind: oven, room: 1c, at: [80, 1] }")).toThrow(/outside room 1c/);
    expect(broken("{ kind: fan, room: 2a", "{ kind: rocket, room: 2a")).toThrow(/unknown kind rocket/);
    expect(broken("mascot: cat-agent", "mascot: jukebox")).toThrow(/must be a character/);
    expect(broken("{ type: spin, part: drum, speed: 0.4 }", "{ type: spin, part: lid, speed: 0.4 }")).toThrow(/unknown part lid/);
    expect(broken("{ type: wander, speed: 0.6, amount: 2.5 }", "{ type: teleport, speed: 0.6, amount: 2.5 }")).toThrow();
  });
});
