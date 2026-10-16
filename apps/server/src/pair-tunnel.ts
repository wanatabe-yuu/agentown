import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A temporary public HTTPS address for pairing links, so pairing a machine needs no domain and
 * no service run by anyone else: a Cloudflare quick tunnel (cloudflared, no account, a random
 * trycloudflare.com name) to a small listener that answers the pairing link and nothing else.
 * It opens when a link is made and closes (process gone, listener closed) once no link is
 * waiting any more: claimed, expired or replaced. While closed it costs nothing.
 */
export class PairTunnel {
  /** Its address while it is up. */
  url: string | null = null;
  private waiting = new Map<string, NodeJS.Timeout>();
  private up: Promise<string | null> | null = null;
  private proc: ChildProcess | null = null;
  private server: http.Server | null = null;
  private home: string | null = null;

  constructor(
    private readonly bin: string,
    private readonly handle: http.RequestListener,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Keep it up for this link (by its key) for at most `ms`; its address, or null when it did not come up. */
  async open(key: string, ms: number): Promise<string | null> {
    clearTimeout(this.waiting.get(key));
    this.waiting.set(key, setTimeout(() => this.done(key), ms).unref());
    this.up ??= this.start();
    const url = await this.up;
    if (!url) {
      this.up = null;
      this.done(key);
    }
    return url;
  }

  /** This link no longer waits; when none does, it closes. */
  done(key: string) {
    clearTimeout(this.waiting.get(key));
    this.waiting.delete(key);
    if (!this.waiting.size) this.stop();
  }

  stop() {
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
    this.proc?.kill();
    this.proc = null;
    this.server?.closeAllConnections();
    this.server?.close();
    this.server = null;
    if (this.home) rmSync(this.home, { recursive: true, force: true });
    this.home = null;
    this.url = null;
    this.up = null;
  }

  private async start(): Promise<string | null> {
    const server = (this.server = http.createServer(this.handle));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    // An empty home of its own: no named tunnel's config or credentials get picked up.
    const home = (this.home = mkdtempSync(join(tmpdir(), "agentown-pair-")));
    const proc = (this.proc = spawn(this.bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { env: { ...process.env, HOME: home }, stdio: ["ignore", "ignore", "pipe"] }));
    return new Promise((resolve) => {
      let said = "";
      const end = (url: string | null, why?: string) => {
        clearTimeout(late);
        if (why) this.log(`pairing tunnel: ${why}`);
        if (url) this.url = url;
        resolve(url);
      };
      const late = setTimeout(() => end(null, "no address within 30 s"), 30_000);
      proc.stderr!.on("data", (d: Buffer) => {
        said = (said + d.toString()).slice(-4000);
        const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/.exec(said);
        if (m) end(m[0]);
      });
      proc.on("error", (err) => end(null, err.message));
      proc.on("exit", (code) => {
        if (this.proc !== proc) return end(null); // closed by us
        end(null, `cloudflared exited (${code})`);
        // Gone while links still wait: they stop working; a new link opens it again.
        this.stop();
      });
    });
  }
}
