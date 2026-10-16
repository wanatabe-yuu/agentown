import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PairTunnel } from "../src/pair-tunnel.ts";

// A stand-in for cloudflared: says its address the way cloudflared does, notes its pid and arguments.
const dir = mkdtempSync(join(tmpdir(), "fake-cloudflared-"));
const bin = join(dir, "cloudflared");
writeFileSync(bin, `#!/bin/sh\necho $$ > ${dir}/pid\necho "$@" > ${dir}/args\necho "INF Requesting new quick Tunnel on https://api.trycloudflare.com..." >&2\necho "INF |  https://quiet-fox-1.trycloudflare.com  |" >&2\nexec sleep 300\n`);
chmodSync(bin, 0o755);
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

describe("pairing links on a temporary address", () => {
  it("opens for waiting links, answers only through its own listener, and is gone once none waits", async () => {
    const tunnel = new PairTunnel(bin, (_req, res) => res.end("pairing"));
    expect(await tunnel.open("a", 60_000)).toBe("https://quiet-fox-1.trycloudflare.com");
    expect(await tunnel.open("b", 60_000)).toBe("https://quiet-fox-1.trycloudflare.com"); // one tunnel for both
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    const local = readFileSync(join(dir, "args"), "utf8").match(/--url (\S+)/)![1]!;
    expect(local).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await (await fetch(local)).text()).toBe("pairing");

    tunnel.done("a");
    expect(alive(pid)).toBe(true);
    tunnel.done("b");
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    await expect(fetch(local)).rejects.toThrow();
    expect(tunnel.url).toBeNull();
  });

  it("an expired link closes it too; without cloudflared there is no temporary address", async () => {
    const tunnel = new PairTunnel(bin, (_req, res) => res.end());
    await tunnel.open("a", 100);
    const pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    await until(() => !alive(pid));
    expect(alive(pid)).toBe(false);
    expect(await new PairTunnel(join(dir, "missing"), (_req, res) => res.end()).open("a", 60_000)).toBeNull();
  });
});
