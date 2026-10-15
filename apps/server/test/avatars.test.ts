import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

describe("an agent's own look", () => {
  it("is saved in the world and must name a character kind", async () => {
    const cur = (await env.call(env.owner, "GET", "/api/world")).body;
    const world = cur.world ?? { floors: [{ id: "f1", name: "Floor 1", rooms: [{ id: "r1", name: "Room", department: "eng", area: { x: 0, z: 0, w: 8, d: 6 } }] }] };
    const put = (byAgent: unknown, revision: number) => env.call(env.owner, "PUT", "/api/world", { revision, world: { ...world, avatars: { ...world.avatars, byAgent } } });

    expect((await put({ "lead-eng": { kind: "nope" } }, cur.revision)).status).toBe(400);
    expect((await put({ "lead-eng": { character: "dragon" } }, cur.revision)).status).toBe(400);
    const ok = await put({ "lead-eng": { character: "robot", color: "#e11d48" } }, cur.revision);
    expect(ok.status).toBe(200);
    const snap = (await env.call(env.owner, "GET", "/api/office/snapshot")).body;
    expect(snap.world.avatars.byAgent["lead-eng"]).toEqual({ character: "robot", color: "#e11d48" });
  });
});
