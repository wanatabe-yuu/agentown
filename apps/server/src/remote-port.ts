import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import dgram from "node:dgram";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import { join } from "node:path";

/**
 * Paired machines reach this server directly on a port of its own: TLS with a certificate made
 * here, whose key each machine pins at pairing (so no certificate authority, no domain, and no
 * one on the way can read or change what goes through). It answers pairing links and the
 * computer bridge only; the rest of Agentown is not on it.
 */
export interface RemotePort {
  port: number;
  /** SHA-256 of the certificate's public key, base64 (curl's --pinnedpubkey sha256//…). */
  pin: string;
  /** This server's public address, when it has one (stated, or learned once from STUN). */
  publicHost: string | null;
}

/** The certificate and key (made once, kept with the server's state). Needs openssl. */
export function remoteTls(dir: string) {
  const key = join(dir, "remote-key.pem");
  const cert = join(dir, "remote-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3650", "-subj", "/CN=agentown", "-keyout", key, "-out", cert], { stdio: "ignore" });
    chmodSync(key, 0o600);
  }
  const pem = readFileSync(cert, "utf8");
  return { key: readFileSync(key, "utf8"), cert: pem, pin: pinOf(pem) };
}

export const pinOf = (certPem: string) => createHash("sha256").update(createPublicKey(certPem).export({ type: "spki", format: "der" })).digest("base64");

/** The port: pairing links (answered by `pair`) and /api/browser/… (on to this server's own HTTP port); nothing else. */
export function remoteListener(opts: { port: number; target: number; key: string; cert: string; pair: http.RequestListener }) {
  const allowed = (url = "") => url.startsWith("/api/browser/");
  const headers = (raw: string[]) => {
    const out: string[] = [];
    for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() !== "x-forwarded-proto") out.push(`${raw[i]}: ${raw[i + 1]}`);
    return [...out, "x-forwarded-proto: https"];
  };
  const server = https.createServer({ key: opts.key, cert: opts.cert }, (req, res) => {
    if (req.url === "/api/browser/hello") return res.writeHead(200, { "content-type": "application/json" }).end('{"agentown":true}');
    if (req.url?.startsWith("/pair/")) return opts.pair(req, res);
    if (!allowed(req.url)) return res.writeHead(404).end();
    const up = http.request({ host: "127.0.0.1", port: opts.target, method: req.method, path: req.url, headers: { ...req.headers, "x-forwarded-proto": "https" } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("upgrade", (req, socket, head) => {
    if (!allowed(req.url)) return socket.destroy();
    const up = net.connect(opts.target, "127.0.0.1", () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers(req.rawHeaders).join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  return new Promise<https.Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "0.0.0.0", () => resolve(server));
  });
}

export type RouteKind = "domain" | "public" | "lan" | "tailscale";

/** Where a machine may find this server: its public address (stated or learned), its own networks (and Tailscale's). */
export function routesOf(port: number, publicHost: string | null): Array<{ address: string; kind: RouteKind }> {
  const kindOf = (host: string): RouteKind | null => {
    if (host === "localhost" || /^127\.|^::1$|^0\.0\.0\.0$/.test(host)) return null;
    if (net.isIP(host) !== 4) return net.isIP(host) ? null : "domain";
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return "tailscale";
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(host)) return "lan";
    return "public";
  };
  const hosts = [publicHost];
  // Container and cluster bridges are not reachable from other machines.
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|cni|flannel|cali|kube|vxlan|virbr|bridge|awdl|llw)/.test(name)) continue;
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) hosts.push(a.address);
  }
  const out = new Map<string, RouteKind>();
  for (const h of hosts) {
    const kind = h ? kindOf(h) : null;
    if (h && kind && !out.has(h)) out.set(h, kind);
  }
  return [...out].map(([host, kind]) => ({ address: `${host}:${port}`, kind }));
}

/** This server's public IPv4 as the internet sees it: one STUN request (only the address is learned). */
export function stunPublicIp(server = "stun.cloudflare.com", port = 3478, ms = 3000): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const id = randomBytes(12);
    const done = (ip: string | null) => {
      clearTimeout(late);
      sock.close();
      resolve(ip);
    };
    const late = setTimeout(() => done(null), ms);
    sock.on("error", () => done(null));
    sock.on("message", (m) => {
      if (m.length < 20 || !m.subarray(8, 20).equals(id)) return;
      for (let i = 20; i + 4 <= m.length; ) {
        const type = m.readUInt16BE(i);
        const len = m.readUInt16BE(i + 2);
        // XOR-MAPPED-ADDRESS, IPv4
        if (type === 0x0020 && m[i + 5] === 0x01) return done([0, 1, 2, 3].map((k) => m[i + 8 + k]! ^ [0x21, 0x12, 0xa4, 0x42][k]!).join("."));
        i += 4 + len + ((4 - (len % 4)) % 4);
      }
      done(null);
    });
    const req = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), id]);
    sock.send(req, port, server);
  });
}
