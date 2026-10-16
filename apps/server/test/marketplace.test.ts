import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { EventBus } from "../src/bus.ts";
import { createPool, migrate } from "../src/db.ts";
import { Instance } from "../src/instance.ts";
import { SecretBox } from "../src/secrets.ts";
import { sha256 } from "../src/util.ts";

// A fresh install starts with no world; the admin makes the first one from the marketplace.
const INDEX = "https://raw.githubusercontent.com/wanatabe-yuu/agentown-marketplace/main/index.json";
const lab = readFileSync(new URL("./fixtures/templates/lab.yaml", import.meta.url), "utf8");
const files: Record<string, string> = {
  "https://raw.githubusercontent.com/wanatabe-yuu/agentown-marketplace/abc123/worlds/lab.yaml": lab,
  "https://raw.githubusercontent.com/someone/world/abc123/agentown.world.yaml": lab.replace("name: Science lab", "name: Someone's lab"),
  "https://evil.example/lab.yaml": lab,
};
const world = (id: string, url: string, body = files[url]!) => ({ id, name: id, url, sha256: sha256(body), size: body.length, official: id === "lab" });
const index = {
  version: 1,
  worlds: [
    world("lab", "https://raw.githubusercontent.com/wanatabe-yuu/agentown-marketplace/abc123/worlds/lab.yaml"),
    world("github:someone/world", "https://raw.githubusercontent.com/someone/world/abc123/agentown.world.yaml"),
    world("elsewhere", "https://evil.example/lab.yaml"),
    { ...world("changed", "https://raw.githubusercontent.com/wanatabe-yuu/agentown-marketplace/abc123/worlds/lab.yaml"), sha256: "0".repeat(64) },
  ],
};
const fakeFetch = (async (url: string) =>
  url === INDEX ? new Response(JSON.stringify(index)) : files[url] ? new Response(files[url]) : new Response("nope", { status: 404 })) as typeof fetch;

let db: ReturnType<typeof createPool>;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let owner: string;
const call = async (method: string, url: string, body?: unknown, token = owner) => {
  const res = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${token}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() };
};

beforeAll(async () => {
  db = createPool(process.env.DATABASE_URL_TEST ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown_test");
  await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(db);
  const config = readFileSync(new URL("../../../config/agentown.yaml", import.meta.url), "utf8");
  const instance = new Instance(db, config, new EventBus(), SecretBox.forTests(), async () => [], undefined, { indexUrl: INDEX, fetch: fakeFetch });
  owner = (await instance.bootstrap()).ownerToken!;
  ({ app } = await buildApp({ instance, driver: null }));
});
afterAll(async () => {
  await app.close();
  await db.end();
});

describe("marketplace", () => {
  it("a fresh install has no world, and the admin can still sign in", async () => {
    const me = await call("GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.body.orgs).toEqual([]);
    expect(me.body.user.admin).toBe(true);
    const templates = (await call("GET", "/api/templates")).body.templates;
    expect(templates.map((t: { id: string; name: string }) => [t.id, t.name])).toEqual([["company", "Agentown"]]);
  });

  it("lists the marketplace and makes a world from one of its templates", async () => {
    const list = await call("GET", "/api/marketplace");
    expect(list.body.enabled).toBe(true);
    expect(list.body.worlds.map((w: { id: string }) => w.id)).toEqual(["lab", "github:someone/world", "elsewhere", "changed"]);
    const installed = await call("POST", "/api/marketplace/install", { id: "lab" });
    expect(installed.status).toBe(201);
    expect(installed.body.name).toBe("Science lab");
    const org = await call("POST", "/api/admin/orgs", { id: "lab", name: "Lab", templateId: installed.body.id, owner: { userId: "owner" } });
    expect(org.status).toBe(201);
    expect((await call("GET", "/api/me")).body.orgs.map((o: { id: string }) => o.id)).toEqual(["lab"]);
    // Community worlds come pinned from GitHub.
    expect((await call("POST", "/api/marketplace/install", { id: "github:someone/world" })).body.name).toBe("Someone's lab");
  });

  it("downloads only from known hosts and only the bytes the index lists", async () => {
    expect((await call("POST", "/api/marketplace/install", { id: "elsewhere" })).body.message).toMatch(/evil\.example/);
    expect((await call("POST", "/api/marketplace/install", { id: "changed" })).body.message).toMatch(/checksum/);
    expect((await call("POST", "/api/marketplace/install", { id: "nothing" })).status).toBe(404);
  });
});
