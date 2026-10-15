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

  it("a template carries what its world is called; the importer can rename it", async () => {
    const yaml = await env.instance.exportTemplate({ kind: "human", id: "owner", admin: true } as never, "coffee-store");
    expect(yaml).toMatch(/term: café/);
    const imported = await env.call(env.owner, "POST", "/api/templates", { yaml, term: "quán" });
    expect(imported.status).toBe(201);
    expect(imported.body.term).toBe("quán");
    expect((await env.call(env.owner, "POST", "/api/templates", { yaml, term: "" })).status).toBe(400);
    const r = await env.call(env.owner, "POST", "/api/admin/orgs", { id: "quan", name: "Quán", templateId: imported.body.id, language: "vi", owner: { displayName: "Bé" } });
    expect(r.status).toBe(201);
    const svc = await env.instance.org("quan");
    expect(svc.config.organization).toMatchObject({ language: "vi", term: "quán" });
    expect(svc.config.departments.find((d) => d.id === "bar")!.name).toBe("Quầy pha chế");
    // The install's own organization predates terms: it takes its built-in template's.
    expect((await env.instance.org("agentown")).config.organization.term).toBe("company");
  });
});
