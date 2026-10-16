import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { tinyGlb } from "../src/assets.ts";
import { buildApp } from "../src/app.ts";
import { EventBus } from "../src/bus.ts";
import { createPool, migrate } from "../src/db.ts";
import { Instance } from "../src/instance.ts";
import { SecretBox } from "../src/secrets.ts";
import { sha256 } from "../src/util.ts";

// A world bundle: its YAML and the art its world uses (assets/NAME), carried into every organization made from it.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const GLB = tinyGlb();
const doc = parse(readFileSync(new URL("./fixtures/templates/coffee-store.yaml", import.meta.url), "utf8"));
doc.meta = { ...doc.meta, id: "art-lab", name: "Art lab" };
doc.world.floors[0].rooms[0].floorTexture = "assets/floor.png";
doc.world.kinds.statue = { name: "Statue", category: "static", look: { asset: "assets/statue.glb" } };
doc.world.objects.push({ id: "statue", kind: "statue", room: doc.world.floors[0].rooms[0].id, at: [1, 1] });
const yaml = stringify(doc);
const b64 = (b: Buffer) => b.toString("base64");

const INDEX = "https://raw.githubusercontent.com/o/m/main/index.json";
const RAW = "https://raw.githubusercontent.com/o/m/abc/worlds";
const served: Record<string, Buffer> = { [`${RAW}/art-lab.yaml`]: Buffer.from(yaml), [`${RAW}/art-lab/assets/floor.png`]: PNG, [`${RAW}/art-lab/assets/statue.glb`]: GLB };
const listing = (assets: Array<{ path: string; url: string; sha256: string; size: number }>) => ({
  version: 1,
  worlds: [{ id: "art-lab", name: "Art lab", url: `${RAW}/art-lab.yaml`, sha256: sha256(yaml), size: yaml.length, official: true, assets, images: [`${RAW}/art-lab/cover.png`] }],
});
const good = [
  { path: "assets/floor.png", url: `${RAW}/art-lab/assets/floor.png`, sha256: sha256(PNG), size: PNG.length },
  { path: "assets/statue.glb", url: `${RAW}/art-lab/assets/statue.glb`, sha256: sha256(GLB), size: GLB.length },
];
let index = listing(good);
const fakeFetch = (async (url: string) =>
  url === INDEX ? new Response(JSON.stringify(index)) : served[url] ? new Response(new Uint8Array(served[url])) : new Response("nope", { status: 404 })) as typeof fetch;

let db: ReturnType<typeof createPool>;
let app: Awaited<ReturnType<typeof buildApp>>["app"];
let owner: string;
const call = async (method: string, url: string, body?: unknown) => {
  const res = await app.inject({ method: method as "GET", url, headers: { authorization: `Bearer ${owner}` }, ...(body !== undefined ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() };
};
const org = async (id: string, templateId: string) => {
  const r = await call("POST", "/api/admin/orgs", { id, name: id, templateId, owner: { userId: "owner" } });
  expect(r.status).toBe(201);
  const config = (await db.query("SELECT config FROM organizations WHERE id=$1", [id])).rows[0].config;
  const assets = (await db.query("SELECT id, kind, name, sha256 FROM assets WHERE org_id=$1 ORDER BY kind", [id])).rows;
  return { world: config.world, assets };
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

describe("world bundles", () => {
  it("an upload brings the art its world uses, and is refused without it or with the wrong kind of file", async () => {
    expect((await call("POST", "/api/templates", { yaml, files: [{ path: "assets/floor.png", contentBase64: b64(PNG) }] })).body.message).toContain("assets/statue.glb");
    expect((await call("POST", "/api/templates", { yaml, files: [{ path: "assets/floor.png", contentBase64: b64(PNG) }, { path: "assets/statue.glb", contentBase64: b64(PNG) }] })).status).toBe(400);
    const r = await call("POST", "/api/templates", { yaml, files: [{ path: "assets/floor.png", contentBase64: b64(PNG) }, { path: "assets/statue.glb", contentBase64: b64(GLB) }, { path: "assets/unused.png", contentBase64: b64(PNG) }] });
    expect(r.status).toBe(201);
    // An organization made from it has the art in its own library, and its world points there.
    const { world, assets } = await org("gallery", r.body.id);
    expect(assets.map((a: { kind: string; name: string }) => [a.kind, a.name])).toEqual([["model", "statue.glb"], ["texture", "floor.png"]]);
    expect(world.floors[0].rooms[0].floorTexture).toBe(assets.find((a: { kind: string }) => a.kind === "texture").id);
    expect(world.kinds.statue.look.asset).toBe(assets.find((a: { kind: string }) => a.kind === "model").id);
    // A second one gets its own copies.
    const again = await org("gallery-2", r.body.id);
    expect(again.assets.map((a: { id: string }) => a.id)).not.toEqual(assets.map((a: { id: string }) => a.id));
  });

  it("saving an organization as a template keeps its art as bundle files", async () => {
    const saved = await call("POST", "/api/orgs/gallery/templates", { name: "Gallery copy", description: "" });
    expect(saved.status).toBe(201);
    const files = (await db.query("SELECT path, kind FROM template_assets WHERE template_id=$1 ORDER BY path", [saved.body.id])).rows;
    expect(files).toEqual([{ path: "assets/floor.png", kind: "texture" }, { path: "assets/statue.glb", kind: "model" }]);
    const { world, assets } = await org("gallery-3", saved.body.id);
    expect(world.floors[0].rooms[0].floorTexture).toBe(assets.find((a: { kind: string }) => a.kind === "texture").id);
  });

  it("from the marketplace: its art is downloaded and checked like its YAML", async () => {
    const listed = (await call("GET", "/api/marketplace")).body.worlds[0];
    expect(listed.images).toEqual([`${RAW}/art-lab/cover.png`]);
    index = listing([good[0]!, { ...good[1]!, sha256: "0".repeat(64) }]);
    expect((await call("POST", "/api/marketplace/install", { id: "art-lab" })).body.message).toContain("checksum mismatch");
    index = listing([good[0]!, { ...good[1]!, url: "https://evil.example/statue.glb" }]);
    expect((await call("POST", "/api/marketplace/install", { id: "art-lab" })).body.message).toContain("evil.example");
    index = listing(good);
    const r = await call("POST", "/api/marketplace/install", { id: "art-lab" });
    expect(r.status).toBe(201);
    expect((await org("market-lab", r.body.id)).assets).toHaveLength(2);
  });
});
