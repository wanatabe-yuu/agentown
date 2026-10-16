import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setup } from "./helpers.ts";

type Env = Awaited<ReturnType<typeof setup>>;
let env: Env;
const hls = "/* pretend hls.js */window.Hls={isSupported:()=>false};";

beforeAll(async () => {
  const webDist = mkdtempSync(join(tmpdir(), "web-dist-"));
  mkdirSync(join(webDist, "vendor"));
  writeFileSync(join(webDist, "vendor/hls.min.js"), hls);
  env = await setup(undefined, { webDist });
});
afterAll(async () => {
  await env?.close();
});

describe("the player's script", () => {
  it("is served by this server, on the player's own path and on the one paired machines reach", async () => {
    for (const [page, script] of [["/player", "/player.js"], ["/api/browser/player", "/api/browser/player.js"]] as const) {
      const html = await env.app.inject({ method: "GET", url: `${page}?src=https://example.com/live.m3u8` });
      expect(html.body).toContain('<script src="player.js"></script>');
      const js = await env.app.inject({ method: "GET", url: script });
      expect(js.statusCode).toBe(200);
      expect(String(js.headers["content-type"])).toMatch(/javascript/);
      expect(js.body).toBe(hls);
    }
  });
});
