import { mkdtempSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { remoteListener, remoteTls, routesOf } from "../src/remote-port.ts";

// Agentown's own HTTP port, as the direct port sees it: says what it was asked; upgrades say so too.
const target = http.createServer((req, res) => res.end(`${req.url} ${req.headers["x-forwarded-proto"]}`));
target.on("upgrade", (req, socket) => socket.end(`HTTP/1.1 101 Switching Protocols\r\nx-path: ${req.url}\r\nx-proto: ${req.headers["x-forwarded-proto"]}\r\n\r\n`));
await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
const keys = remoteTls(mkdtempSync(join(tmpdir(), "agentown-remote-")));
const server = await remoteListener({ port: 0, target: (target.address() as AddressInfo).port, ...keys, pair: (req, res) => res.end(`pair ${req.url}`) });
const port = (server.address() as AddressInfo).port;
afterAll(() => {
  server.close();
  target.close();
});

const get = (path: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    const req = https.request({ host: "127.0.0.1", port, path, headers, rejectUnauthorized: false }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on("upgrade", (res) => resolve({ status: res.statusCode!, body: "", headers: res.headers }));
    req.on("error", reject);
    req.end();
  });

describe("the direct port for paired machines", () => {
  it("its key is what machines pin", async () => {
    const seen = await new Promise<string>((resolve) => {
      const s = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
        resolve(createHash("sha256").update(s.getPeerX509Certificate()!.publicKey.export({ type: "spki", format: "der" })).digest("base64"));
        s.destroy();
      });
    });
    expect(seen).toBe(keys.pin);
  });

  it("carries pairing links and the computer bridge to Agentown (as https), and nothing else", async () => {
    expect(await get("/api/browser/hello")).toMatchObject({ status: 200, body: '{"agentown":true}' });
    expect(await get("/pair/apr_x")).toMatchObject({ status: 200, body: "pair /pair/apr_x" });
    expect(await get("/api/browser/network", { "x-forwarded-proto": "http" })).toMatchObject({ body: "/api/browser/network https" });
    expect((await get("/api/me")).status).toBe(404);
    expect((await get("/")).status).toBe(404);
    const up = await get("/api/browser/bridge", { connection: "upgrade", upgrade: "websocket" });
    expect(up).toMatchObject({ status: 101, headers: { "x-path": "/api/browser/bridge", "x-proto": "https" } });
    await expect(get("/api/orgs/x/chat", { connection: "upgrade", upgrade: "websocket" })).rejects.toThrow();
  });

  it("offers its public address and its own networks, never localhost", () => {
    expect(routesOf(7443, "203.0.113.5")).toContainEqual({ address: "203.0.113.5:7443", kind: "public" });
    expect(routesOf(7443, "agentown.example.com")).toContainEqual({ address: "agentown.example.com:7443", kind: "domain" }); // stated by its owner
    expect(routesOf(7443, "localhost").some((r) => r.address.startsWith("localhost") || r.address.startsWith("127."))).toBe(false);
    expect(routesOf(7443, "100.101.102.103")).toContainEqual({ address: "100.101.102.103:7443", kind: "tailscale" });
  });
});
