#!/usr/bin/env node
/**
 * render-shots: a video from a shot list, with ffmpeg (on a computer with the terminal app).
 *
 *   render-shots SHOTS.json OUT.mp4
 *   render-shots serve DIR [PORT]     DIR's videos on http://127.0.0.1:PORT (default 8090), only
 *                                     inside this computer: its own screen plays them (the stream app)
 *
 * SHOTS.json (paths are relative to it):
 *   { "width": 1080, "height": 1920, "fps": 30,
 *     "music": "assets/bed.m4a", "voice": "assets/vo.mp3", "musicVolume": 0.18,
 *     "shots": [
 *       { "dur": 2.5, "color": "#101418", "text": "The hook, big in the middle" },
 *       { "dur": 4, "image": "assets/a.jpg", "caption": "A line along the bottom" },
 *       { "dur": 3, "video": "assets/b.mp4", "start": 12.5, "caption": "…" },
 *       { "dur": 5, "layout": "split", "image": "assets/c.jpg", "text": "1. Axolotl", "caption": "…" } ] }
 *
 * Each shot is a background (a video clip, a still with a slow push-in, or a colour) with an
 * optional big centred `text` and a bottom `caption`. layout "split": the picture on one half
 * (side "right", the default, or "left"), the words on the other, over `color` (black).
 * Optional per shot: "textColor" (#hex), "textSize" (× the usual, 0.3–2), "bold": false (the
 * regular face), "fade" (seconds through black at each end; at the top, for every shot).
 * Otherwise cuts are hard. The sound is the voice over the music (or silence),
 * normalised to -14 LUFS for the platforms.
 */
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/** Files under root, with ranges (players seek), to this computer alone. */
function serve(root, port) {
  createServer((req, res) => {
    const f = resolve(join(root, decodeURIComponent((req.url ?? "/").split("?")[0])));
    if (!f.startsWith(root + sep) || !existsSync(f) || !statSync(f).isFile()) return res.writeHead(404).end();
    const size = statSync(f).size;
    const type = f.endsWith(".mp4") ? "video/mp4" : f.endsWith(".webm") ? "video/webm" : f.endsWith(".jpg") ? "image/jpeg" : f.endsWith(".png") ? "image/png" : "application/octet-stream";
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    if (m) {
      const a = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
      const b = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${a}-${b}/${size}`, "content-length": b - a + 1 });
      return createReadStream(f, { start: a, end: b }).pipe(res);
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": size });
    createReadStream(f).pipe(res);
  }).listen(port, "127.0.0.1", () => console.log(`serving ${root} on http://127.0.0.1:${port}/`));
}

// The shot list being rendered (render-shots renders one per run).
let spec, base, W, H, FPS, FONT, shots, total, work;
const at = (p) => (isAbsolute(p) ? p : join(base, p));

function render(file, out) {
  if (!file || !out) fail("usage: render-shots SHOTS.json OUT.mp4");
  spec = JSON.parse(readFileSync(file, "utf8"));
  base = dirname(resolve(file));
  W = int(spec.width ?? 1080, 240, 3840, "width");
  H = int(spec.height ?? 1920, 240, 3840, "height");
  FPS = int(spec.fps ?? 30, 12, 60, "fps");
  FONT = spec.font ?? "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf";
  shots = Array.isArray(spec.shots) ? spec.shots : [];
  if (!shots.length || shots.length > 300) fail("shots: 1 to 300 of them");
  if (/[:'\\]/.test(FONT) || !existsSync(FONT)) fail(`font not found (or its path has : ' \\): ${FONT}`);
  total = shots.reduce((n, s, i) => n + num(s.dur, 0.3, 60, `shots[${i}].dur`), 0);
  if (total > 900) fail("at most 15 minutes in all");

  work = mkdtempSync(join(dirname(resolve(out)), ".render-"));
  try {
    const parts = shots.map((s, i) => {
      console.log(`shot ${i + 1}/${shots.length}`);
      return shot(s, i);
    });
    writeFileSync(join(work, "list.txt"), parts.map((p) => `file '${p}'\n`).join(""));
    ffmpeg(["-f", "concat", "-safe", "0", "-i", join(work, "list.txt"), "-c", "copy", join(work, "video.mp4")]);
    console.log("sound");
    sound(join(work, "video.mp4"), resolve(out));
    console.log(`done ${out} (${total.toFixed(1)} s, ${W}x${H})`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** One shot as its own clip: same size, rate and codec, so they join without re-encoding. */
function shot(s, i) {
  const dur = Number(s.dur);
  const frames = Math.max(1, Math.round(dur * FPS));
  const split = s.layout === "split";
  const left = s.side === "left"; // split: the picture's side (default right), the words on the other
  const color = String(s.color ?? (split ? "#000000" : "#111318"));
  if (!/^#[0-9a-fA-F]{6}$|^[a-z]{3,20}$/.test(color)) fail(`shots[${i}].color: a colour like #101418 or black`);
  const pw = split ? Math.round(W / 2) : W;
  let input, chain;
  if (s.video) {
    input = ["-ss", String(num(s.start ?? 0, 0, 86400, `shots[${i}].start`)), "-t", String(dur), "-i", media(s.video, i)];
    chain = `scale=${pw}:${H}:force_original_aspect_ratio=increase,crop=${pw}:${H},setsar=1,fps=${FPS}`;
  } else if (s.image) {
    // A slow push-in on the still, from a little larger than the frame.
    const bw = Math.round(pw * 1.15), bh = Math.round(H * 1.15);
    input = ["-i", media(s.image, i)];
    chain = `scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},zoompan=z='min(1+0.10*on/${frames},1.10)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${pw}x${H}:fps=${FPS},setsar=1`;
  } else {
    input = ["-f", "lavfi", "-i", `color=c=${color.replace("#", "0x")}:s=${pw}x${H}:r=${FPS}`];
    chain = "setsar=1";
  }
  // Split: the picture on one half, a plain colour on the other for the words.
  if (split) chain += `,pad=${W}:${H}:${left ? 0 : W - pw}:0:${color.replace("#", "0x")}`;
  const textHalf = split ? { x0: left ? pw : 0, w: W - pw } : { x0: 0, w: W };
  const size = num(s.textSize ?? 1, 0.3, 2, `shots[${i}].textSize`);
  // bold false: the regular face beside the bold one (DejaVuSans-Bold.ttf → DejaVuSans.ttf).
  const light = FONT.replace(/-Bold(?=\.[a-z]+$)/i, "");
  const font = s.bold === false && existsSync(light) ? light : FONT;
  if (s.text) chain += `,${draw(s.text, Math.round((split ? W * 0.55 : W) * 0.075 * size), "(h-text_h)/2", textHalf, i, "t", !split, s.textColor, font)}`;
  if (s.caption) chain += `,${draw(s.caption, Math.round(W * (split ? 0.03 : 0.05)), split && s.text ? `(h/2)+${Math.round(H * 0.1)}` : `h-text_h-${Math.round(H * 0.12)}`, split && s.text ? textHalf : { x0: 0, w: W }, i, "c", true)}`;
  const fade = num(s.fade ?? spec.fade ?? 0, 0, dur / 2, `shots[${i}].fade`);
  if (fade) chain += `,fade=t=in:st=0:d=${fade},fade=t=out:st=${(dur - fade).toFixed(3)}:d=${fade}`;
  const part = join(work, `shot-${String(i).padStart(3, "0")}.mp4`);
  ffmpeg([...input, "-vf", chain, "-frames:v", String(frames), "-r", String(FPS), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", part]);
  return part;
}

/** Text from a file (nothing to escape), wrapped to its area, centred in it (on a soft box over pictures). */
function draw(text, size, y, area, i, tag, box, color, font = FONT) {
  const perLine = Math.max(8, Math.floor((area.w * 0.82) / (size * 0.58)));
  const lines = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line && (line + " " + word).length > perLine) {
        lines.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    lines.push(line);
  }
  const f = join(work, `text-${i}-${tag}.txt`);
  writeFileSync(f, lines.join("\n").slice(0, 1000));
  const fg = /^#[0-9a-fA-F]{6}$/.test(String(color ?? "")) ? String(color).replace("#", "0x") : "white";
  return `drawtext=fontfile=${font}:textfile=${f}:fontsize=${size}:fontcolor=${fg}:line_spacing=${Math.round(size * 0.25)}:text_align=C:x=${area.x0}+(${area.w}-text_w)/2:y=${y}` +
    (box ? `:box=1:boxcolor=black@0.45:boxborderw=${Math.round(size * 0.4)}` : "");
}

/** The voice over the music (looped, ducked under a voice, faded out), or silence; loudness for the platforms. */
function sound(video, dest) {
  const inputs = ["-i", video];
  const mix = [];
  let n = 1;
  if (spec.voice) {
    inputs.push("-i", media(spec.voice, "voice"));
    mix.push(`[${n++}:a]aresample=48000[v]`);
  }
  if (spec.music) {
    inputs.push("-stream_loop", "-1", "-i", media(spec.music, "music"));
    const vol = num(spec.musicVolume ?? (spec.voice ? 0.18 : 0.6), 0, 1, "musicVolume");
    mix.push(`[${n++}:a]aresample=48000,volume=${vol},afade=t=out:st=${Math.max(0, total - 1.5).toFixed(2)}:d=1.5[m]`);
  }
  if (!mix.length) inputs.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  const labels = mix.map((m) => m.slice(m.lastIndexOf("[")));
  const graph = mix.length
    ? `${mix.join(";")};${labels.join("")}${labels.length > 1 ? `amix=inputs=${labels.length}:duration=longest:normalize=0,` : ""}loudnorm=I=-14:TP=-1.5:LRA=11,apad[a]`
    : "[1:a]anull[a]";
  ffmpeg([...inputs, "-filter_complex", graph, "-map", "0:v", "-map", "[a]", "-t", total.toFixed(3), "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-movflags", "+faststart", dest]);
}

function media(p, i) {
  const f = at(String(p));
  if (!existsSync(f)) fail(`shots[${i}]: no such file ${f}`);
  return f;
}

function ffmpeg(args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) fail(`ffmpeg failed:\n${(r.stderr || r.error?.message || "").slice(-1500)}`);
}

function num(v, min, max, what) {
  const x = Number(v);
  if (!Number.isFinite(x) || x < min || x > max) fail(`${what}: a number from ${min} to ${max}`);
  return x;
}

function int(v, min, max, what) {
  return Math.round(num(v, min, max, what));
}

function fail(msg) {
  console.error(`render-shots: ${msg}`);
  process.exit(1);
}

if (process.argv[2] === "serve") serve(resolve(process.argv[3] ?? "."), Number(process.argv[4] ?? 8090));
else render(process.argv[2], process.argv[3]);
