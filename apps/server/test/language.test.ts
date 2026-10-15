import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env.close();
});

describe("template language", () => {
  it("only the owner sets it; names switch over and agents are told to write in it", async () => {
    expect((await env.call(env.token("lead-eng"), "PUT", "/api/language", { language: "vi" })).status).toBe(403);
    expect((await env.call(env.owner, "PUT", "/api/language", { language: "fr" })).status).toBe(400);
    expect((await env.call(env.owner, "PUT", "/api/language", { language: "vi" })).status).toBe(200);

    const snap = (await env.call(env.owner, "GET", "/api/office/snapshot")).body;
    expect(snap.organization.language).toBe("vi");
    expect(snap.departments.find((d: any) => d.id === "eng").name).toBe("Kỹ thuật");
    const service = await env.instance.org("agentown");
    const agent = (await env.db.query("SELECT * FROM agents WHERE id='lead-eng'")).rows[0];
    expect((await service.runConfig(agent)).instructions).toMatch(/^Work in Vietnamese/);

    expect((await env.call(env.owner, "PUT", "/api/language", { language: "en" })).status).toBe(200);
    const back = (await env.call(env.owner, "GET", "/api/office/snapshot")).body;
    expect(back.departments.find((d: any) => d.id === "eng").name).toBe("Engineering");
    expect((await (await env.instance.org("agentown")).runConfig(agent)).instructions).not.toMatch(/Vietnamese/);
  });
});
