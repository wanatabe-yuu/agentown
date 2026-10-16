// A computer's runtime: an X display, Chromium on it, and one WebSocket out to
// Agentown that carries the DevTools protocol both ways (the server drives the
// browser and streams its screen; nothing here accepts connections from outside).
// The same image runs in Agentown's cluster or on a paired machine elsewhere.
//
// On that socket, text frames are DevTools JSON, except control frames from the
// server ({"agentown": ...}: video on/off, ping) which never reach Chromium; binary
// frames going up are H.264 video (1 byte: 1 = keyframe, 0 = not, then one access unit).
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statfsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

const { AGENTOWN_API_URL: api, AGENTOWN_TOKEN: token } = process.env;
const W = 1280;
const H = 800;
const profile = "/workspace/profile";
const tmp = "/tmp/agentown";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const origin = api.replace(/\/$/, "");
let networkNote = null;

// ---- how to reach Agentown. On a paired machine: only directly, at one of its addresses (TLS, its
// key pinned at pairing: nobody on the way can read or change anything), through a local port that
// carries each connection there; none answering, it waits and tries again. In Agentown's cluster: its address.
const routes = (process.env.AGENTOWN_ROUTES ?? "").split(",").filter(Boolean);
const pin = process.env.AGENTOWN_PIN ?? "";
let via = null;
const pinned = (route) =>
  new Promise((resolve) => {
    const at = route.lastIndexOf(":");
    const host = route.slice(0, at);
    const s = tls.connect({ host, port: Number(route.slice(at + 1)), rejectUnauthorized: false, ...(net.isIP(host) ? {} : { servername: host }), timeout: 5000 }, () => {
      const key = s.getPeerX509Certificate()?.publicKey.export({ type: "spki", format: "der" });
      if (key && createHash("sha256").update(key).digest("base64") === pin) return resolve(s.setTimeout(0));
      s.destroy();
      resolve(null);
    });
    s.on("error", () => resolve(null));
    s.on("timeout", () => {
      s.destroy();
      resolve(null);
    });
  });
let local = null;
if (routes.length && pin) {
  const server = net.createServer(async (c) => {
    c.pause();
    const s = via && (await pinned(via));
    if (!s) return c.destroy();
    s.on("error", () => c.destroy());
    c.on("error", () => s.destroy());
    c.pipe(s).pipe(c);
    c.resume();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  local = `http://127.0.0.1:${server.address().port}`;
}
/** The first route that answers with Agentown's key (null: none does); in the cluster, its address. */
async function reach() {
  // All at once (an unreachable one waits out its timeout); the first in order that answered wins.
  const answers = pin ? await Promise.all(routes.map(pinned)) : [];
  for (const s of answers) s?.destroy();
  const r = routes[answers.findIndex(Boolean)];
  if (r) {
    if (via !== r) console.log(`[browser] reaching Agentown directly at ${r}`);
    via = r;
    return local;
  }
  if (!routes.length) return origin;
  if (via !== "") console.log(`[browser] Agentown does not answer at ${routes.join(", ")}: trying again`);
  via = "";
  return null;
}
let base = await reach();

const run = (cmd, args) => {
  const p = spawn(cmd, args, { stdio: "inherit" });
  p.on("exit", (code) => {
    console.error(`[browser] ${cmd} exited (${code}); restarting the computer`);
    process.exit(1);
  });
  return p;
};

mkdirSync(process.env.HOME ?? "/workspace/home", { recursive: true });
mkdirSync(profile, { recursive: true });
mkdirSync(tmp, { recursive: true });
// A restarted container leaves the old one's profile lock behind.
for (const f of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) rmSync(`${profile}/${f}`, { force: true });

// ---- network: direct, a proxy, or a VPN (WireGuard in user space), as the owner set it for this computer.
async function network() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(`${base}/api/browser/network`, { headers: { authorization: `Bearer ${token}` } });
      if (r.ok) return await r.json();
      if (r.status === 401 || r.status === 403) break;
    } catch {}
    await sleep(2000);
  }
  return { mode: "direct" };
}

/** A local proxy that adds the upstream proxy's login (Chromium cannot take one on its command line). */
function forwardTo(upstream) {
  const auth = upstream.username ? `Basic ${Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString("base64")}` : null;
  const host = upstream.hostname;
  const port = Number(upstream.port || 80);
  const server = http.createServer((req, res) => {
    const up = http.request({ host, port, method: req.method, path: req.url, headers: { ...req.headers, ...(auth ? { "proxy-authorization": auth } : {}) } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on("error", () => res.writeHead(502).end());
    req.pipe(up);
  });
  server.on("connect", (req, client, head) => {
    const up = net.connect(port, host, () => {
      up.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ""}\r\n`);
      if (head.length) up.write(head);
      client.pipe(up).pipe(client);
    });
    up.on("error", () => client.destroy());
    client.on("error", () => up.destroy());
  });
  server.listen(3128, "127.0.0.1");
  return "http://127.0.0.1:3128";
}

async function proxyFlag() {
  const n = await network();
  if (n.mode === "proxy" && n.proxy) {
    try {
      const u = new URL(n.proxy);
      if (u.protocol === "socks5:" || u.protocol === "socks5h:") {
        if (u.username) networkNote = "SOCKS5 with a login is not supported: use an HTTP proxy for that";
        return `--proxy-server=socks5://${u.host}`;
      }
      return `--proxy-server=${forwardTo(u)}`;
    } catch {
      networkNote = "the proxy address could not be read";
    }
  }
  if (n.mode === "vpn" && n.wireguard) {
    writeFileSync(`${tmp}/wg.conf`, n.wireguard, { mode: 0o600 });
    writeFileSync(`${tmp}/wireproxy.conf`, `WGConfig = ${tmp}/wg.conf\n\n[Socks5]\nBindAddress = 127.0.0.1:25344\n`, { mode: 0o600 });
    run("wireproxy", ["-s", "-c", `${tmp}/wireproxy.conf`]);
    await sleep(1500);
    return "--proxy-server=socks5://127.0.0.1:25344";
  }
  if (n.mode !== "direct") networkNote = `${n.mode} is chosen but not set up yet: browsing directly`;
  return null;
}
// A paired machine browses directly (its own network); proxies and VPNs are for computers in the cluster.
const proxy = routes.length ? null : await proxyFlag();

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
  // A browser window as people know it (its address bar, extensions, profiles); the video leaves out
  // the tab strip above (one tab at a time). App windows (videos, camera, terminal) go full screen.
  "--test-type", // no "unsupported command-line flag" bar for --no-sandbox
  "--hide-crash-restore-bubble", // a restarted computer is not a crash to restore from
  `--window-size=${W},${H}`,
  "--window-position=0,0",
  "--autoplay-policy=no-user-gesture-required",
  // Agentown itself (the player page for videos and cameras) is reached directly, never through the proxy.
  ...(proxy ? [proxy, `--proxy-bypass-list=${new URL(origin).host};<local>`] : []),
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

// ---- terminal: a shell in this container (a real terminal: `script` gives it one), on a page only
// this container's browser opens. A random key in that page guards it: other pages the browser
// visits cannot send it keys (a custom header needs CORS, which it never grants), nor load it
// under another name (the Host must be its own).
const TERM_PORT = 7681;
const termKey = randomBytes(16).toString("hex");
const termEnv = { HOME: process.env.HOME ?? "/workspace/home", PATH: process.env.PATH, TERM: "xterm-256color", LANG: "C.UTF-8", SHELL: "/bin/bash", COLUMNS: "120", LINES: "36" };
const term = { clients: new Set(), log: "", shell: null };
const say = (text) => {
  term.log = (term.log + text).slice(-100_000);
  for (const res of term.clients) res.write(`data: ${JSON.stringify(text)}\n\n`);
};
function startShell() {
  const sh = spawn("script", ["-qfec", "stty cols 120 rows 36 2>/dev/null; cd /workspace; exec bash -l", "/dev/null"], { env: termEnv, stdio: ["pipe", "pipe", "pipe"] });
  sh.stdout.on("data", (d) => say(d.toString()));
  sh.stderr.on("data", (d) => say(d.toString()));
  sh.on("error", () => {});
  sh.on("exit", () => {
    say("\r\n[the shell ended: a new one starts]\r\n");
    setTimeout(startShell, 1000);
  });
  term.shell = sh;
}
const XTERM_FILES = { "/xterm.js": ["./xterm/lib/xterm.js", "text/javascript"], "/xterm.css": ["./xterm/css/xterm.css", "text/css"] };
const termPage = `<!doctype html><meta charset="utf-8"><title>Terminal</title>
<link rel="stylesheet" href="/xterm.css">
<style>html,body{margin:0;height:100%;background:#0b0e14;overflow:hidden}#t{height:100%;display:flex;align-items:center;justify-content:center}</style>
<div id="t"></div><script src="/xterm.js"></script><script>
const key=${JSON.stringify(termKey)};
const size=Math.max(10,Math.floor(Math.min(innerWidth/(120*0.61),innerHeight/(36*1.22))));
const term=new Terminal({cols:120,rows:36,fontSize:size,cursorBlink:true,scrollback:5000,theme:{background:"#0b0e14"}});
term.open(document.getElementById("t"));term.focus();
let q="",busy=false;
const flush=async()=>{if(busy||!q)return;busy=true;const b=q;q="";try{await fetch("/in",{method:"POST",headers:{"x-agentown-term":key},body:b})}finally{busy=false;flush()}};
term.onData(d=>{q+=d;flush()});
const listen=async()=>{for(;;){try{const r=await fetch("/out",{headers:{"x-agentown-term":key}});const rd=r.body.getReader();const dec=new TextDecoder();let buf="";for(;;){const {value,done}=await rd.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf("\\n\\n"))>=0){const line=buf.slice(0,i);buf=buf.slice(i+2);if(line.startsWith("data: "))term.write(JSON.parse(line.slice(6)))}}}catch{}await new Promise(r=>setTimeout(r,1000))}};
listen();
</script>`;
http
  .createServer((req, res) => {
    if (req.headers.host !== `127.0.0.1:${TERM_PORT}`) return res.writeHead(403).end();
    const guard = { "x-frame-options": "DENY", "content-security-policy": "frame-ancestors 'none'", "cache-control": "no-store" };
    if (req.method === "GET" && req.url === "/") return res.writeHead(200, { ...guard, "content-type": "text/html; charset=utf-8" }).end(termPage);
    // xterm.js, put in the image at build time (pinned by SHA-256 in the Dockerfile); never fetched from a CDN.
    const asset = req.method === "GET" && XTERM_FILES[req.url];
    if (asset) return res.writeHead(200, { ...guard, "content-type": asset[1] }).end(readFileSync(new URL(asset[0], import.meta.url)));
    if (req.headers["x-agentown-term"] !== termKey) return res.writeHead(403).end();
    if (req.method === "GET" && req.url === "/out") {
      res.writeHead(200, { ...guard, "content-type": "text/event-stream" });
      if (term.log) res.write(`data: ${JSON.stringify(term.log)}\n\n`);
      term.clients.add(res);
      req.on("close", () => term.clients.delete(res));
      return;
    }
    if (req.method === "POST" && req.url === "/in") {
      let n = 0;
      req.on("data", (d) => {
        if ((n += d.length) <= 65_536) term.shell?.stdin.write(d);
      });
      req.on("end", () => res.writeHead(204, guard).end());
      return;
    }
    res.writeHead(404).end();
  })
  .listen(TERM_PORT, "127.0.0.1");
startShell();

/** A command someone asked the computer to run: shown in the terminal, its output sent back (last 20000 characters). */
function runCommand(up, m) {
  const send = (o) => up.readyState === 1 && up.send(JSON.stringify({ agentown: "ran", id: m.id, ...o }));
  say(`\r\n\x1b[36m$ ${String(m.command).replace(/\n/g, "\r\n  ")}\x1b[0m\r\n`);
  const p = spawn("bash", ["-lc", String(m.command)], { cwd: "/workspace", env: termEnv, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let cut = false;
  let timedOut = false;
  const add = (d) => {
    const t = d.toString();
    out += t;
    if (out.length > 20_000) [out, cut] = [out.slice(-20_000), true];
    say(t.replace(/\r?\n/g, "\r\n"));
  };
  p.stdout.on("data", add);
  p.stderr.on("data", add);
  const late = setTimeout(() => {
    timedOut = true;
    p.kill("SIGKILL");
  }, 120_000);
  p.on("error", (err) => {
    clearTimeout(late);
    send({ code: null, output: err.message, timedOut: false });
  });
  p.on("close", (code) => {
    clearTimeout(late);
    say(`\x1b[2m[exit ${code}]\x1b[0m\r\n`);
    send({ code, output: (cut ? "…" : "") + out, timedOut });
  });
}

// ---- video: the screen as H.264 (x264, no lookahead), one access unit per message.
let video = null;
function startVideo(up, w, h, fps, top = 0) {
  stopVideo();
  // `top`: rows of the screen left out above (the browser's tab strip).
  const t = Math.max(0, Math.min(H - 100, Math.round(top)));
  const ff = spawn("ffmpeg", [
    "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(fps), "-video_size", `${W}x${H - t}`, "-i", `:99.0+0,${t}`,
    "-vf", `scale=${w}:${h}`, "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-level", "4.0",
    "-pix_fmt", "yuv420p", "-g", String(fps), "-bf", "0", "-x264-params", "aud=1:repeat-headers=1", "-f", "h264", "-",
  ], { stdio: ["ignore", "pipe", "inherit"] });
  let buf = Buffer.alloc(0);
  // An access unit starts at an access unit delimiter (NAL type 9); send each one whole.
  const aud = (b, from) => {
    for (let i = from; i + 4 < b.length; i++) {
      if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 0x1f) === 9) return i > 0 && b[i - 1] === 0 ? i - 1 : i;
    }
    return -1;
  };
  const isKey = (au) => {
    for (let i = 0; i + 3 < au.length; i++) if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1 && (au[i + 3] & 0x1f) === 5) return true;
    return false;
  };
  ff.stdout.on("data", (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let start = aud(buf, 0);
    if (start < 0) return;
    for (;;) {
      const next = aud(buf, start + 4);
      if (next < 0) break;
      const au = buf.subarray(start, next);
      // A slow link skips frames (the next keyframe comes within a second) instead of falling behind.
      if (up.readyState === 1 && up.bufferedAmount < 1_500_000) up.send(Buffer.concat([Buffer.from([isKey(au) ? 1 : 0]), au]));
      start = next;
    }
    buf = buf.subarray(start);
  });
  ff.on("exit", () => video?.ff === ff && (video = null));
  video = { ff, w, h, fps };
}
function stopVideo() {
  video?.ff.kill("SIGKILL");
  video = null;
}

// ---- input as a person's: the mouse and keys of this screen itself (X), so the browser's own bar,
// menus, extensions and profiles work too. Coordinates come in screen pixels.
const KEYSYM = {
  Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", Delete: "Delete", Insert: "Insert", " ": "space",
  ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next",
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`F${i + 1}`, `F${i + 1}`])),
};
const xq = [];
let xBusy = false;
/** One xdotool at a time, as many commands as are waiting (moves in a row: only the last); `type` ends a run. */
function xRun() {
  if (xBusy || !xq.length) return;
  const run = [];
  while (xq.length) {
    const c = xq.shift();
    if (c[0] === "mousemove" && run.at(-1)?.[0] === "mousemove") run[run.length - 1] = c;
    else run.push(c);
    if (c[0] === "type") break;
  }
  xBusy = true;
  const p = spawn("xdotool", run.flat(), { stdio: "ignore" });
  const next = () => {
    xBusy = false;
    xRun();
  };
  p.on("exit", next);
  p.on("error", next);
}
const x = (...cmd) => {
  if (xq.length < 500) xq.push(cmd.map(String));
  xRun();
};
function xInput(m) {
  const px = Math.max(0, Math.min(W - 1, Math.round(Number(m.x) || 0)));
  const py = Math.max(0, Math.min(H - 1, Math.round(Number(m.y) || 0)));
  const button = { left: 1, middle: 2, right: 3 }[m.button] ?? 1;
  if (m.t === "mouse") {
    x("mousemove", px, py);
    if (m.type === "mousePressed") x("mousedown", button);
    if (m.type === "mouseReleased") x("mouseup", button);
  } else if (m.t === "wheel") {
    x("mousemove", px, py);
    const dy = Number(m.dy) || 0, dx = Number(m.dx) || 0;
    if (dy) x("click", "--repeat", Math.min(10, Math.max(1, Math.round(Math.abs(dy) / 60))), dy > 0 ? 5 : 4);
    if (dx) x("click", "--repeat", Math.min(10, Math.max(1, Math.round(Math.abs(dx) / 60))), dx > 0 ? 7 : 6);
  } else if (m.t === "key" && (m.type === "keyDown" || m.type === "rawKeyDown")) {
    const mods = Number(m.modifiers) || 0;
    const key = String(m.key ?? "");
    const sym = KEYSYM[key] ?? (key.length === 1 ? key.toLowerCase() : null);
    if (!sym) return;
    // Shortcuts are Ctrl here (a Mac's Cmd means the same).
    const combo = [mods & 2 || mods & 4 ? "ctrl" : "", mods & 1 ? "alt" : "", mods & 8 && (key.length !== 1 || mods & 7) ? "shift" : ""].filter(Boolean);
    if (key.length === 1 && !(mods & 7)) x("type", "--delay", "0", "--", key);
    else x("key", "--clearmodifiers", [...combo, sym].join("+"));
  } else if (m.t === "text" && typeof m.text === "string" && m.text) {
    x("type", "--delay", "0", "--", m.text.slice(0, 2000));
  }
}

// ---- health: what Agentown shows about this computer (and, for a paired machine, about the machine).
function health() {
  let disk = null;
  try {
    const s = statfsSync("/workspace");
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {}
  return {
    agentown: "health", host: os.hostname(), os: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length,
    load: os.loadavg(), memory: { total: os.totalmem(), free: os.freemem() }, disk, uptime: Math.round(os.uptime()),
    video: video ? `${video.w}x${video.h}@${video.fps}` : null, network: proxy ? "proxied" : "direct", note: networkNote,
    base, // how this computer's browser reaches Agentown (its player page)
    route: via ? { to: via, direct: true } : null,
  };
}

// One pair of sockets at a time; if either side drops, both close and the pair is made again
// (over the best route at that moment: a laptop that moved networks finds its way again).
for (;;) {
  if (routes.length) base = await reach();
  if (!base) {
    await sleep(10_000);
    continue;
  }
  const url = `${base.replace(/^http/, "ws")}/api/browser/bridge`;
  await new Promise((done) => {
    const cdp = new WebSocket(endpoint);
    const up = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    up.binaryType = "arraybuffer";
    const queue = [];
    let beat = null;
    const close = () => {
      clearInterval(beat);
      stopVideo();
      try { cdp.close(); } catch {}
      try { up.close(); } catch {}
      done();
    };
    cdp.onmessage = (e) => up.readyState === 1 && up.send(e.data);
    up.onmessage = (e) => {
      if (typeof e.data === "string" && e.data.startsWith('{"agentown"')) {
        const m = JSON.parse(e.data);
        if (m.agentown === "ping") up.send(JSON.stringify({ agentown: "pong", t: m.t }));
        else if (m.agentown === "video") m.on ? startVideo(up, m.w, m.h, m.fps ?? 30, m.top ?? 0) : stopVideo();
        else if (m.agentown === "input") xInput(m);
        else if (m.agentown === "run" && typeof m.id === "string" && typeof m.command === "string") runCommand(up, m);
        return;
      }
      return cdp.readyState === 1 ? cdp.send(e.data) : queue.push(e.data);
    };
    cdp.onopen = () => queue.splice(0).forEach((m) => cdp.send(m));
    up.onopen = () => {
      console.log("[browser] connected to Agentown");
      up.send(JSON.stringify(health()));
      beat = setInterval(() => up.readyState === 1 && up.send(JSON.stringify(health())), 10_000);
    };
    for (const s of [cdp, up]) {
      s.onclose = close;
      s.onerror = close;
    }
  });
  await sleep(2000);
}
