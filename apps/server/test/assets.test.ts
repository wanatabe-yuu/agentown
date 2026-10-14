import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sniffAsset, tinyGlb } from "../src/assets.ts";
import { setup } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
beforeAll(async () => {
  env = await setup();
});
afterAll(async () => {
  await env?.close();
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const upload = (token: string, kind: string, body: Buffer, org = "agentown", name = "x") =>
  env.app.inject({ method: "POST", url: `/api/orgs/${org}/assets?kind=${kind}&name=${name}`, headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" }, payload: body });

describe("asset files", () => {
  it("are judged by their bytes", () => {
    expect(sniffAsset(tinyGlb(), "model")).toEqual({ kind: "model", contentType: "model/gltf-binary" });
    expect(sniffAsset(PNG, "texture").contentType).toBe("image/png");
    expect(() => sniffAsset(PNG, "model")).toThrow(/not a binary glTF/);
    expect(() => sniffAsset(tinyGlb(), "texture")).toThrow(/PNG, JPEG or WebP/);
    expect(() => sniffAsset(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "texture")).toThrow();
    expect(() => sniffAsset(tinyGlb({ buffers: [{ byteLength: 36, uri: "https://evil.example/x.bin" }] }), "model")).toThrow(/external/);
    expect(() => sniffAsset(tinyGlb({ images: [{ uri: "data:image/png;base64,AAAA" }] }), "model")).toThrow(/external/);
    expect(() => sniffAsset(tinyGlb({ extensionsRequired: ["KHR_draco_mesh_compression"] }), "model")).toThrow(/Draco/);
    const truncated = tinyGlb().subarray(0, 60);
    expect(() => sniffAsset(truncated, "model")).toThrow(/length/);
  });
});

describe("the asset library and the world", () => {
  let model = "";
  let designer = "";

  it("org.design uploads; members read; agents and outsiders do not", async () => {
    const r = await upload(env.owner, "model", tinyGlb(), "agentown", "chair.glb");
    expect(r.statusCode).toBe(201);
    model = r.json().id;
    expect(r.json()).toMatchObject({ kind: "model", contentType: "model/gltf-binary", name: "chair.glb" });
    // The same bytes again: the same asset.
    expect((await upload(env.owner, "model", tinyGlb())).json().id).toBe(model);

    const viewer = (await env.call(env.owner, "POST", "/api/users", { displayName: "Vi", roleId: "viewer" })).body.token;
    expect((await upload(viewer, "texture", PNG)).statusCode).toBe(403);
    const get = await env.app.inject({ method: "GET", url: `/api/orgs/agentown/assets/${model}`, headers: { authorization: `Bearer ${viewer}` } });
    expect(get.statusCode).toBe(200);
    expect(get.headers["content-type"]).toBe("model/gltf-binary");
    expect(get.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(get.headers["content-security-policy"])).toMatch(/sandbox/);
    expect(get.headers["cache-control"]).toMatch(/immutable/);
    const again = await env.app.inject({ method: "GET", url: `/api/orgs/agentown/assets/${model}`, headers: { authorization: `Bearer ${viewer}`, "if-none-match": String(get.headers.etag) } });
    expect(again.statusCode).toBe(304);
    expect((await env.call(env.token("ceo"), "GET", `/api/assets/${model}`)).status).toBe(403);

    const other = await env.call(env.owner, "POST", "/api/admin/orgs", { id: "elsewhere", name: "Elsewhere", templateId: "lab", owner: { displayName: "El" } });
    const elsewhere = other.body.ownerToken;
    expect((await env.app.inject({ method: "GET", url: `/api/orgs/elsewhere/assets/${model}`, headers: { authorization: `Bearer ${elsewhere}` } })).statusCode).toBe(404);
  });

  it("rejects what is not art, and what is too big", async () => {
    expect((await upload(env.owner, "texture", Buffer.from("<svg/>"))).statusCode).toBe(400);
    expect((await upload(env.owner, "model", tinyGlb({ buffers: [{ byteLength: 36, uri: "x.bin" }] }))).statusCode).toBe(400);
    expect((await upload(env.owner, "model", Buffer.alloc(21 * 1024 * 1024))).statusCode).toBe(413);
  });

  it("a designer edits the world but not the organization's structure", async () => {
    const d = await env.call(env.owner, "POST", "/api/users", { displayName: "Dee", roleId: null });
    designer = d.body.token;
    await env.call(env.owner, "POST", `/api/users/${d.body.user.id}/grants`, { action: "org.design", scope: { kind: "org" } });
    await env.call(env.owner, "POST", `/api/users/${d.body.user.id}/grants`, { action: "org.view", scope: { kind: "org" } });
    const { revision } = (await env.call(designer, "GET", "/api/world")).body;
    const world = {
      floors: [{ id: "f1", name: "Floor 1", rooms: [{ id: "eng", name: "Engineering", department: "eng", area: { x: 0, z: 0, w: 10, d: 8 }, floorTexture: "as-missing" }] }],
      kinds: { chair: { name: "Chair", category: "static", look: { asset: model } } },
      objects: [{ kind: "chair", room: "eng", at: [2, 2] }],
    };
    const missing = await env.call(designer, "PUT", "/api/world", { revision, world });
    expect(missing.status).toBe(400);
    expect(missing.body.message).toMatch(/as-missing/);
    delete (world.floors[0]!.rooms[0] as Record<string, unknown>).floorTexture;
    const ok = await env.call(designer, "PUT", "/api/world", { revision, world });
    expect(ok.status).toBe(200);
    expect((await env.call(designer, "GET", "/api/office/snapshot")).body.world.kinds.chair.look.asset).toBe(model);
    expect((await env.call(designer, "GET", "/api/config")).status).toBe(403);
    expect((await env.call(designer, "PUT", "/api/world", { revision, world })).status).toBe(409);
    // Clearing the world goes back to one room per department.
    expect((await env.call(designer, "PUT", "/api/world", { revision: ok.body.revision, world: null })).status).toBe(200);
    expect((await env.call(designer, "GET", "/api/office/snapshot")).body.world).toBeNull();
  });
});
