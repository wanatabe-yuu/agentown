// A computer's runtime: an X display, Chromium on it, and one WebSocket out to
// Agentown that carries the DevTools protocol both ways (the server drives the
// browser and streams its screen; nothing here accepts connections).
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";

const { AGENTOWN_API_URL: api, AGENTOWN_TOKEN: token } = process.env;
const W = 1280;
const H = 800;
const profile = "/workspace/profile";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const run = (cmd, args) => {
  const p = spawn(cmd, args, { stdio: "inherit" });
  p.on("exit", (code) => {
    console.error(`[browser] ${cmd} exited (${code}); restarting the computer`);
    process.exit(1);
  });
};

mkdirSync(process.env.HOME ?? "/workspace/home", { recursive: true });
mkdirSync(profile, { recursive: true });
// A restarted container leaves the old one's profile lock behind.
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(`${profile}/${f}`, { force: true });

run("Xvfb", [":99", "-screen", "0", `${W}x${H}x24`, "-nolisten", "tcp"]);
process.env.DISPLAY = ":99";
await sleep(400);
const chromium = ["/usr/bin/chromium", "/usr/bin/chromium-browser"].find(existsSync);
run(chromium, [
  `--user-data-dir=${profile}`,
  "--remote-debugging-port=9222",
  // No user namespaces in an unprivileged container; the container is the sandbox.
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--log-level=3",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-blink-features=AutomationControlled",
  "--password-store=basic",
  "--disable-features=Translate,MediaRouter",
  `--window-size=${W},${H}`,
  "--window-position=0,0",
  "--start-maximized",
  "about:blank",
]);

let endpoint = null;
for (let i = 0; i < 100 && !endpoint; i++) {
  try {
    endpoint = (await (await fetch("http://127.0.0.1:9222/json/version")).json()).webSocketDebuggerUrl;
  } catch {
    await sleep(300);
  }
}
if (!endpoint) {
  console.error("[browser] Chromium did not open its DevTools endpoint");
  process.exit(1);
}

// One pair of sockets at a time; if either side drops, both close and the pair is made again.
const url = `${api.replace(/^http/, "ws").replace(/\/$/, "")}/api/browser/bridge`;
for (;;) {
  await new Promise((done) => {
    const cdp = new WebSocket(endpoint);
    const up = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    const queue = [];
    const close = () => {
      try { cdp.close(); } catch {}
      try { up.close(); } catch {}
      done();
    };
    cdp.onmessage = (e) => up.readyState === 1 && up.send(e.data);
    up.onmessage = (e) => (cdp.readyState === 1 ? cdp.send(e.data) : queue.push(e.data));
    cdp.onopen = () => queue.splice(0).forEach((m) => cdp.send(m));
    up.onopen = () => console.log("[browser] connected to Agentown");
    for (const s of [cdp, up]) {
      s.onclose = close;
      s.onerror = close;
    }
  });
  await sleep(2000);
}
