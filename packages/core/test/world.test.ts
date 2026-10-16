import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseTemplate, splitInstanceConfig } from "../src/index.ts";
import { canTalk, chatTemplateOf, worldSchema } from "../src/world.ts";

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
    expect(broken("department: kitchen\n", "department: nowhere\n")).toThrow(/unknown department nowhere/);
    expect(broken("{ kind: oven, room: 1c, at: [7.0, 0.5] }", "{ kind: oven, room: 1c, at: [80, 0.5] }")).toThrow(/outside room 1c/);
    expect(broken("{ kind: ceiling-fan, room: 2a", "{ kind: rocket, room: 2a")).toThrow(/unknown kind rocket/);
    expect(broken("mascot: cat-agent", "mascot: jukebox")).toThrow(/must be a character/);
    expect(broken("{ type: spin, part: drum, axis: x, speed: 0.35 }", "{ type: spin, part: lid, axis: x, speed: 0.35 }")).toThrow(/unknown part lid/);
    expect(broken("behaviors: [{ type: roam, amount: 0.6 }]", "behaviors: [{ type: teleport }]")).toThrow();
    expect(broken("access: own-department", "access: { zone: vip }")).toThrow(/unknown zone vip/);
    expect(broken("{ to: 2b, side: east, at: 4 }", "{ to: 1b, side: east, at: 4 }")).toThrow(/different floors/);
  });

  it("objects talk with the chat template of their title; their own settings win", () => {
    const { doc } = parseTemplate(coffee, catalog);
    const world = worldSchema.parse(doc.world);
    const counter = world.objects.find((o) => o.kind === "counter")!;
    const rug = world.objects.find((o) => o.kind === "rug")!;
    expect(canTalk(world, counter)).toBe(true);
    expect(chatTemplateOf(world, counter)?.instructions).toMatch(/order counter/);
    expect(canTalk(world, rug)).toBe(false);
    // A title of its own picks another template; switching chat off still wins.
    expect(chatTemplateOf(world, { ...rug, title: "Menu" })?.instructions).toMatch(/menu board/);
    expect(canTalk(world, { ...counter, chat: { enabled: false } })).toBe(false);
  });
});
