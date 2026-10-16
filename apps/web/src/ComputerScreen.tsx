import { useCallback, useEffect, useRef, useState } from "react";
import { api, orgPath } from "./api.ts";
import { t } from "./i18n.ts";
import { StatusPill } from "./ui.tsx";
import type { PlacedComputer } from "@agentown/core/world";

type Status = { state: "off" | "starting" | "on" | "error"; detail: string | null };

const STATE: Record<Status["state"], string> = { off: "Off", starting: "Starting…", on: "On", error: "Could not start" };

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. On a Mac, Cmd acts as Ctrl (the computer runs Linux). */
const mods = (e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) =>
  (e.altKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.shiftKey ? 8 : 0);

/**
 * One of the world's computers, live: its screen streams in, and the mouse,
 * keyboard and address bar here drive it (to log in to a site for the agents,
 * say). Opening it turns the computer on; it turns itself off when nobody has
 * used or watched it for a while.
 */
export function ComputerScreen({ objectId, apps = ["browser"], notify }: { objectId: string; apps?: string[]; notify: (msg: string, kind?: "error" | "info") => void }) {
  const [status, setStatus] = useState<Status>({ state: "starting", detail: null });
  const [page, setPage] = useState({ url: "", title: "", showing: "browser" });
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [big, setBig] = useState(false);
  const [typed, setTyped] = useState("");
  /** Bumped to connect again (turning it back on). */
  const [session, setSession] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const img = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  /**
   * H.264 (30 fps, encoded by the computer itself) where the browser decodes it (WebCodecs:
   * Chrome, Edge, Safari 16.4+); JPEG frames elsewhere. Each H.264 message is one access unit
   * after a byte saying whether it is a keyframe; JPEG messages start with the JPEG marker.
   */
  const codec = useRef<"h264" | "jpeg" | null>(null);
  const decoder = useRef<VideoDecoder | null>(null);
  const keyed = useRef(false);
  const decode = (buf: ArrayBuffer) => {
    const bytes = new Uint8Array(buf);
    if (bytes[0] === 0xff) return void draw(new Blob([bytes], { type: "image/jpeg" }));
    const key = bytes[0] === 1;
    if (!key && !keyed.current) return; // wait for a keyframe to start from
    let d = decoder.current;
    if (!d || d.state === "closed") {
      d = decoder.current = new VideoDecoder({
        output: (frame) => {
          const cv = img.current;
          if (cv) {
            if (cv.width !== frame.displayWidth || cv.height !== frame.displayHeight) {
              cv.width = frame.displayWidth;
              cv.height = frame.displayHeight;
            }
            cv.getContext("2d")?.drawImage(frame, 0, 0);
          }
          frame.close();
        },
        error: () => {
          keyed.current = false; // start again at the next keyframe
          decoder.current = null;
        },
      });
      d.configure({ codec: "avc1.420028", optimizeForLatency: true });
    }
    // Behind (a slow phone): drop until the next keyframe rather than lag.
    if (!key && d.decodeQueueSize > 4) return;
    keyed.current = true;
    d.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp: performance.now() * 1000, data: bytes.subarray(1) }));
  };
  useEffect(() => {
    let live = true;
    const probe = typeof VideoDecoder === "undefined" ? Promise.resolve(false)
      : VideoDecoder.isConfigSupported({ codec: "avc1.420028", optimizeForLatency: true }).then((r) => !!r.supported).catch(() => false);
    void probe.then((ok) => {
      if (!live) return;
      codec.current = ok ? "h264" : "jpeg";
      sendView();
    });
    return () => {
      live = false;
      if (decoder.current && decoder.current.state !== "closed") decoder.current.close();
    };
  }, []);

  /** The newest frame not drawn yet: drawing never falls behind, older frames are dropped. */
  const pending = useRef<Blob | null>(null);
  const drawing = useRef(false);
  const draw = async (frame: Blob) => {
    pending.current = frame;
    if (drawing.current) return;
    drawing.current = true;
    try {
      while (pending.current) {
        const next = pending.current;
        pending.current = null;
        const bmp = await createImageBitmap(next);
        const cv = img.current;
        if (cv) {
          if (cv.width !== bmp.width || cv.height !== bmp.height) {
            cv.width = bmp.width;
            cv.height = bmp.height;
          }
          cv.getContext("2d")?.drawImage(bmp, 0, 0);
        }
        bmp.close();
      }
    } catch {
      // a broken frame: the next one replaces it
    } finally {
      drawing.current = false;
    }
  };
  const size = useRef({ w: 1280, h: 800 });
  /** The page's proportions, so the screen box fits the picture. */
  const [aspect, setAspect] = useState("16 / 10");
  const lastMove = useRef(0);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const open = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const sock = new WebSocket(`${proto}://${location.host}${orgPath(`/api/computers/${encodeURIComponent(objectId)}/screen`)}`);
      sock.binaryType = "arraybuffer";
      ws.current = sock;
      sock.onopen = () => sendView();
      sock.onmessage = (e) => {
        // Frames are binary JPEG; everything else is a small JSON message.
        if (typeof e.data !== "string") return decode(e.data as ArrayBuffer);
        const m = JSON.parse(e.data);
        if (m.t === "size") {
          if (m.w && m.h && (m.w !== size.current.w || m.h !== size.current.h)) {
            size.current = { w: m.w, h: m.h };
            setAspect(`${m.w} / ${m.h}`);
          }
        } else if (m.t === "page") setPage({ url: m.url, title: m.title, showing: m.showing ?? "browser" });
        else if (m.t === "status") setStatus({ state: m.state, detail: m.detail });
      };
      sock.onclose = (e) => {
        if (closed) return;
        if (e.code === 4403) setStatus({ state: "error", detail: t("You may not use this computer.") });
        else retry = setTimeout(open, 3000);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws.current?.close();
    };
  }, [objectId, session]);

  useEffect(() => {
    if (!editing) setAddress(page.url === "about:blank" ? "" : page.url);
  }, [page.url, editing]);

  const send = (m: unknown) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify(m));
  /** Tell the computer how big the screen box is here, so frames are no bigger than that. */
  const sendView = () => {
    const el = box.current;
    if (el && codec.current) send({ t: "view", w: el.clientWidth, h: el.clientHeight, dpr: window.devicePixelRatio || 1, codec: codec.current });
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let last = "";
    const ro = new ResizeObserver(() => {
      const key = `${Math.round(el.clientWidth / 40)}x${Math.round(el.clientHeight / 40)}`;
      if (key !== last) {
        last = key;
        sendView();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Full screen on a phone follows the visible area, so the keyboard does not cover the screen. */
  const [vv, setVv] = useState<{ top: number; height: number } | null>(null);
  useEffect(() => {
    const v = window.visualViewport;
    if (!big || !v) return setVv(null);
    const fit = () => setVv({ top: v.offsetTop, height: v.height });
    fit();
    v.addEventListener("resize", fit);
    v.addEventListener("scroll", fit);
    return () => {
      v.removeEventListener("resize", fit);
      v.removeEventListener("scroll", fit);
    };
  }, [big]);
  /** A finger on the screen: a tap clicks, a drag scrolls the page. */
  const touch = useRef<{ x: number; y: number; lastX: number; lastY: number; moved: boolean } | null>(null);
  /** Where on the page (CSS pixels of the computer's viewport) a pointer event is. */
  /** The picture's scale and place (it may be letterboxed: full screen keeps its proportions). */
  const fit = () => {
    const r = img.current!.getBoundingClientRect();
    const { w, h } = size.current;
    const k = Math.min(r.width / w, r.height / h);
    return { k, left: r.left + (r.width - w * k) / 2, top: r.top + (r.height - h * k) / 2 };
  };
  const at = (e: { clientX: number; clientY: number }) => {
    const { k, left, top } = fit();
    const { w, h } = size.current;
    return { x: Math.min(w, Math.max(0, (e.clientX - left) / k)), y: Math.min(h, Math.max(0, (e.clientY - top) / k)) };
  };
  const button = (b: number) => (b === 1 ? "middle" : b === 2 ? "right" : "left");

  /**
   * Keys that are not text (Enter, arrows, shortcuts) go as key presses; text
   * arrives through a hidden field so input methods (Vietnamese Telex, IMEs)
   * and paste work: what they compose is sent as text once it is final.
   */
  const keys = useRef(new Set<string>());
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.key === "Process" || e.key === "Dead") return;
    if (e.key === "Escape" && big) return setBig(false);
    const shortcut = e.ctrlKey || e.metaKey || e.altKey;
    if (e.key.length === 1 && !shortcut) return; // text: see onInput
    if (shortcut && e.key.toLowerCase() === "v") return; // paste: see onInput
    e.preventDefault();
    keys.current.add(e.code);
    send({ t: "key", type: e.key === "Enter" ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e), ...(e.key === "Enter" ? { text: "\r" } : {}) });
  };
  const onKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!keys.current.delete(e.code)) return;
    send({ t: "key", type: "keyUp", key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e) });
  };
  const flush = (field: HTMLTextAreaElement) => {
    if (field.value) send({ t: "text", text: field.value });
    field.value = "";
  };
  const field = useRef<HTMLTextAreaElement>(null);

  const stop = async () => {
    try {
      await api("POST", `/api/computers/${encodeURIComponent(objectId)}/stop`);
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };

  const on = status.state === "on";
  const screens = (["browser", "stream", "camera", "terminal"] as const).filter((a) => apps.includes(a));
  const show = async (app: string) => {
    try {
      await api("POST", `/api/computers/${encodeURIComponent(objectId)}/requests`, { app: "screen", show: app });
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };
  const browsing = page.showing === "browser";
  return (
    <section className={`computer ${big ? "computer-big" : ""}`} aria-label={t("Computer screen")} style={big && vv ? { top: vv.top, height: vv.height, bottom: "auto" } : undefined}>
      <div className="computer-bar">
        {screens.length > 1 && (
          // What its screen shows: one app at a time.
          <select className="computer-app" value={page.showing} disabled={!on} onChange={(e) => void show(e.target.value)} aria-label={t("Screen")}>
            {screens.map((a) => <option key={a} value={a}>{t(a)}</option>)}
          </select>
        )}
        {browsing && (
          <button type="button" className="icon-btn" disabled={!on} onClick={() => send({ t: "back" })} aria-label={t("Back")} title={t("Back")}>
            ←
          </button>
        )}
        {browsing && (
          <button type="button" className="icon-btn computer-extra" disabled={!on} onClick={() => send({ t: "forward" })} aria-label={t("Forward")} title={t("Forward")}>
            →
          </button>
        )}
        <button type="button" className="icon-btn computer-extra" disabled={!on} onClick={() => send({ t: "reload" })} aria-label={t("Reload")} title={t("Reload")}>
          ⟳
        </button>
        {browsing ? <form
          className="computer-address"
          onSubmit={(e) => {
            e.preventDefault();
            if (address.trim()) send({ t: "go", url: address.trim() });
            setEditing(false);
            (document.activeElement as HTMLElement | null)?.blur();
          }}
        >
          <input
            value={address}
            disabled={!on}
            placeholder={t("Search or type an address")}
            aria-label={t("Address")}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(e) => setAddress(e.target.value)}
            spellCheck={false}
            autoCapitalize="off"
          />
        </form> : <span className="computer-address computer-title">{t(page.showing)}</span>}
        <button type="button" className="icon-btn computer-kbd" disabled={!on}
          onClick={() => (document.activeElement === field.current ? field.current?.blur() : field.current?.focus({ preventScroll: true }))}
          aria-label={t("Keyboard")} title={t("Keyboard")}>
          ⌨
        </button>
        <button type="button" className="icon-btn" onClick={() => setBig(!big)} aria-label={big ? t("Smaller") : t("Full screen")} title={big ? t("Smaller") : t("Full screen")}>
          {big ? "⤡" : "⤢"}
        </button>
      </div>
      <div
        ref={box}
        className="computer-screen"
        style={big ? undefined : { aspectRatio: aspect }}
        role="application"
        aria-label={t("Screen of the computer: click to use it, type to send keys")}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.pointerType === "touch") {
            touch.current = { x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, moved: false };
            return;
          }
          e.preventDefault();
          field.current?.focus({ preventScroll: true });
          if (!on || !img.current) return;
          send({ t: "mouse", type: "mousePressed", ...at(e), button: button(e.button), clickCount: e.detail || 1, modifiers: mods(e) });
        }}
        onPointerUp={(e) => {
          if (e.pointerType === "touch") {
            const tp = touch.current;
            touch.current = null;
            if (!tp || tp.moved || !on || !img.current) return;
            // The first tap opens it full screen; taps there click.
            if (!big) return setBig(true);
            const p = at(e);
            send({ t: "mouse", type: "mousePressed", ...p, button: "left", clickCount: 1 });
            send({ t: "mouse", type: "mouseReleased", ...p, button: "left", clickCount: 1 });
            return;
          }
          if (on && img.current) send({ t: "mouse", type: "mouseReleased", ...at(e), button: button(e.button), clickCount: e.detail || 1, modifiers: mods(e) });
        }}
        // iOS follows a tap with a click on this box, which takes the focus off the keyboard field
        // (and closes the keyboard): stop it, and keep the field focused while the finger is the mouse.
        onTouchEnd={(e) => {
          e.preventDefault();
          if (big) field.current?.focus({ preventScroll: true });
        }}
        onPointerMove={(e) => {
          if (e.pointerType === "touch") {
            const tp = touch.current;
            if (!tp || !on || !img.current) return;
            if (!tp.moved && Math.hypot(e.clientX - tp.x, e.clientY - tp.y) < 8) return;
            tp.moved = true;
            const { k } = fit();
            send({ t: "wheel", ...at(e), dx: (tp.lastX - e.clientX) / k, dy: (tp.lastY - e.clientY) / k });
            tp.lastX = e.clientX;
            tp.lastY = e.clientY;
            return;
          }
          const now = Date.now();
          if (!on || !img.current || now - lastMove.current < 50) return;
          lastMove.current = now;
          send({ t: "mouse", type: "mouseMoved", ...at(e), modifiers: mods(e) });
        }}
        onWheel={(e) => on && img.current && send({ t: "wheel", ...at(e), dx: e.deltaX, dy: e.deltaY })}
      >
        <canvas ref={img} className={on ? "" : "hidden"} />
        <textarea
          ref={field}
          className="computer-keys"
          aria-label={t("Keyboard for the computer")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onInput={(e) => !(e.nativeEvent as InputEvent).isComposing && flush(e.currentTarget)}
          onCompositionEnd={(e) => flush(e.currentTarget)}
        />
        {!on && (
          <div className="computer-off">
            <span className={`computer-led led-${status.state}`} aria-hidden />
            <b>{t(STATE[status.state])}</b>
            {status.detail && <span className="muted small">{status.detail}</span>}
            {(status.state === "off" || status.state === "error") && (
              <button type="button" className="primary" onClick={() => setSession((n) => n + 1)}>
                {t("Turn on")}
              </button>
            )}
          </div>
        )}
      </div>
      <form
        className="computer-type"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed) send({ t: "text", text: typed });
          setTyped("");
        }}
      >
        <input value={typed} disabled={!on} onChange={(e) => setTyped(e.target.value)} placeholder={t("Type here, then Send (for phones)")} aria-label={t("Text to type on the computer")} autoCapitalize="off" autoComplete="off" />
        <button type="submit" disabled={!on || !typed}>
          {t("Send")}
        </button>
        {["Enter", "Tab", "Backspace"].map((k) => (
          <button key={k} type="button" disabled={!on} onClick={() => {
            const keyCode = { Enter: 13, Tab: 9, Backspace: 8 }[k]!;
            send({ t: "key", type: k === "Enter" ? "keyDown" : "rawKeyDown", key: k, code: k, keyCode, ...(k === "Enter" ? { text: "\r" } : {}) });
            send({ t: "key", type: "keyUp", key: k, code: k, keyCode });
          }}>
            {k === "Enter" ? "⏎" : k === "Tab" ? "⇥" : "⌫"}
          </button>
        ))}
      </form>
      <div className="computer-foot muted small">
        <span className={`computer-led led-${status.state}`} aria-hidden />
        <span>{!on ? t(STATE[status.state]) : !browsing ? t(page.showing) : page.url === "about:blank" || !page.title ? t("Blank page") : page.title}</span>
        <span className="spacer" />
        {status.state !== "off" && (
          <button type="button" className="link" onClick={() => void stop()}>
            {t("Turn off")}
          </button>
        )}
      </div>
    </section>
  );
}

type Request = { id: string; requester: string; app: string | null; input: Record<string, any>; status: string; result: string | null; createdAt: string };

/** What a request asked for, in a few words. */
function asked(r: Request) {
  const i = r.input;
  if (!r.app) return `“${i.text}”`;
  if (r.app === "screen") return t("show {app}", { app: t(i.show) });
  if (r.app === "browser") return `browser ${i.action}${i.url ? ` ${i.url}` : ""}`;
  if (r.app === "mcp") return `mcp ${i.connector} ${i.tool ?? "tools"}`;
  if (r.app === "stream") return `stream ${i.action}${i.url ? ` ${i.url}` : ""}`;
  if (r.app === "terminal") return `$ ${i.command}`;
  return i.event ? t("camera saw a change") : t("camera look");
}

/**
 * The computer as a colleague: what its screen shows (one app at a time), a box to ask it
 * something, and its queue of requests (from agents, people, and its own camera).
 */
export function ComputerDesk({ objectId, nameOf, notify }: { objectId: string; nameOf: (ref: string) => string; notify: (msg: string, kind?: "error" | "info") => void }) {
  const [requests, setRequests] = useState<Request[]>([]);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const path = `/api/computers/${encodeURIComponent(objectId)}/requests`;
  const load = useCallback(() => void api<{ requests: Request[] }>("GET", path).then((r) => setRequests(r.requests)).catch(() => {}), [path]);
  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, [load]);
  const send = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api("POST", path, body);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
      load();
    }
  };
  return (
    <section className="computer-desk">
      <form className="computer-ask" onSubmit={(e) => { e.preventDefault(); const v = text.trim(); if (v) { setText(""); void send({ text: v }); } }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={t("Ask the computer to do something…")} maxLength={4000} />
        <button type="submit" className="primary" disabled={busy || !text.trim()}>{t("Send")}</button>
      </form>
      <ul className="computer-requests">
        {(all ? requests : requests.slice(0, 3)).map((r) => (
          <li key={r.id} onClick={() => setOpen(open === r.id ? null : r.id)}>
            <div className="req-head"><StatusPill state={r.status} /> <b>{nameOf(r.requester)}</b> <span className="muted">{asked(r)}</span></div>
            {r.result && <div className={`req-result${open === r.id ? " open" : ""}`}>{r.result}</div>}
          </li>
        ))}
        {requests.length > 3 && (
          <li className="req-more">
            <button type="button" className="link" onClick={() => setAll(!all)}>{all ? t("Show fewer") : t("Show all {n}", { n: requests.length })}</button>
          </li>
        )}
        {!requests.length && <li className="muted small">{t("No requests yet. Agents ask with agentown computer {id}; you can ask here.", { id: objectId })}</li>}
      </ul>
    </section>
  );
}

type PcStatus = {
  connected?: boolean;
  health?: { host?: string; os?: string; arch?: string; cpus?: number; load?: number[]; memory?: { total: number; free: number }; disk?: { total: number; free: number } | null; uptime?: number; video?: string | null; note?: string | null; network?: string; route?: { to: string; direct: boolean } | null; at: string; rtt: number | null } | null;
  network?: { mode: string; secretSet: boolean };
  remote?: { machine: { host: string | null; os: string | null; arch: string | null; cpus: number | null; memory_mb: number | null; paired_at: string; last_seen_at: string | null } | null } | null;
};

/** A computer's status, refreshed while shown. */
function useStatus(objectId: string): [PcStatus | null, () => void] {
  const [s, setS] = useState<PcStatus | null>(null);
  const load = useCallback(() => void api<PcStatus>("GET", `/api/computers/${encodeURIComponent(objectId)}`).then(setS).catch(() => {}), [objectId]);
  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);
  return [s, load];
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
const ago = (iso: string) => {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return s < 60 ? t("{n}s ago", { n: s }) : s < 3600 ? t("{n} min ago", { n: Math.round(s / 60) }) : t("{n} h ago", { n: Math.round(s / 3600) });
};

/** Where the computer runs and how it is doing: online, round trip, load, memory, disk, video. */
export function ComputerHealth({ objectId }: { objectId: string }) {
  const [s] = useStatus(objectId);
  if (!s) return null;
  const h = s.health;
  const m = s.remote?.machine;
  const fresh = !!h && Date.now() - Date.parse(h.at) < 30_000;
  return (
    <section className="computer-health">
      <div className="req-head">
        <span className={`computer-led led-${s.connected && fresh ? "on" : s.remote ? "error" : "off"}`} aria-hidden />
        <b>{s.remote ? (m?.host ?? t("Paired machine")) : t("This server")}</b>
        <span className="muted">{s.connected && fresh ? t("online") : s.remote ? (m ? t("offline") : t("not paired yet")) : t("off (starts when used)")}</span>
        {h?.rtt != null && s.connected && <span className="muted">· {h.rtt} ms</span>}
      </div>
      {h && s.connected && (
        <dl className="health-grid">
          <dt>{t("System")}</dt><dd>{h.os} · {h.arch} · {h.cpus} CPU</dd>
          {h.load && <><dt>{t("Load")}</dt><dd>{h.load.map((x) => x.toFixed(2)).join(" / ")}</dd></>}
          {h.memory && <><dt>{t("Memory")}</dt><dd>{gb(h.memory.total - h.memory.free)} / {gb(h.memory.total)}</dd></>}
          {h.disk && <><dt>{t("Disk")}</dt><dd>{gb(h.disk.total - h.disk.free)} / {gb(h.disk.total)}</dd></>}
          {h.uptime != null && <><dt>{t("Up")}</dt><dd>{Math.round(h.uptime / 3600)} h</dd></>}
          {h.route && <><dt>{t("Route")}</dt><dd>{h.route.to} · {t("direct, encrypted end to end")}</dd></>}
          <dt>{t("Network")}</dt><dd>{h.network}{h.note ? ` · ${h.note}` : ""}</dd>
          {h.video && <><dt>{t("Video")}</dt><dd>H.264 {h.video}</dd></>}
          <dt>{t("Checked")}</dt><dd>{ago(h.at)}</dd>
        </dl>
      )}
      {s.remote && m && !s.connected && <p className="muted small">{t("Last seen {when}. It reconnects by itself when the machine and Docker are up.", { when: m.last_seen_at ? ago(m.last_seen_at) : t("never") })}</p>}
      {s.remote && m && !s.connected && <p className="muted small">{t("Still offline? That machine may not reach Agentown: put both on the same network, install Tailscale on both, or give Agentown an address it can reach (an open port, a domain or a tunnel).")}</p>}
    </section>
  );
}

/** Before the machine is paired: how it will reach Agentown, and a warning when only some machines can. */
function PairReach({ routes }: { routes: Array<{ address: string; kind: string }> }) {
  const far = routes.filter((r) => r.kind === "public" || r.kind === "domain");
  const port = routes[0]?.address.split(":").pop();
  return (
    <>
      {routes.length > 0 && <p className="muted small">{t("It connects directly, encrypted end to end, to the first of these it can reach: {list}.", { list: routes.map((r) => r.address).join(", ") })}</p>}
      {far.length > 0 && <p className="muted small">{t("From another network, port {port} of this server must be open (its firewall or router).", { port: port ?? "" })}</p>}
      <p className="muted small">{t("If it reaches none of them, the command stops before setting anything up and says what to do.")}</p>
      {!far.length && (
        <p className="pair-warning small">{t("Only a machine on the same network (or on Tailscale with this one) can connect. For a machine elsewhere: install Tailscale on both, or give Agentown an address it can reach (an open port, a domain or a tunnel).")}</p>
      )}
    </>
  );
}

type Placed = PlacedComputer;
type App = Placed["apps"][number];

/**
 * A computer's settings: off (an ornament) or a studio computer with its apps; where it runs
 * (here in a container of its own, or on a paired machine); and, here, its network.
 */
export function ComputerConfig(p: {
  objectId: string; value: Placed; saved: Placed; canEdit: boolean; owner: boolean;
  connectors: Array<{ id: string; name: string }>; agents: Array<{ id: string; name: string }>;
  onChange: (v: Placed) => void; notify: (msg: string, kind?: "error" | "info") => void;
}) {
  const v = p.value;
  const set = (x: Partial<Placed>) => p.onChange({ ...v, ...x });
  const [s, reload] = useStatus(p.objectId);
  const [secret, setSecret] = useState("");
  const [pairing, setPairing] = useState<{ command: string; expiresAt: string; temporary?: boolean; routes?: Array<{ address: string; kind: "domain" | "public" | "lan" | "tailscale" }> } | null>(null);
  const [busy, setBusy] = useState(false);
  const call = async (method: string, path: string, body?: unknown) => {
    setBusy(true);
    try {
      return await api<any>(method, `/api/computers/${encodeURIComponent(p.objectId)}${path}`, body);
    } catch (e) {
      p.notify((e as Error).message, "error");
      return null;
    } finally {
      setBusy(false);
      reload();
    }
  };
  const app = (a: App, on: boolean) => set({ apps: on ? [...new Set([...v.apps, a])] : v.apps.filter((x) => x !== a) });
  const dis = !p.canEdit;
  return (
    <section className="computer-config">
      <label className="check">
        <input type="checkbox" checked={v.studio} disabled={dis} onChange={(e) => set({ studio: e.target.checked })} />
        <span><b>{t("Studio PC")}</b> <span className="muted small">{t("Runs in a container of its own (its browser profile, network and apps) and takes requests. Off: it is only furniture.")}</span></span>
      </label>
      {v.studio && (
        <>
          <fieldset>
            <legend>{t("Apps")}</legend>
            {(["browser", "mcp", "stream", "camera", "terminal"] as const).map((a) => (
              <label key={a} className="check-inline"><input type="checkbox" checked={v.apps.includes(a)} disabled={dis || (v.apps.length === 1 && v.apps.includes(a)) || (a === "terminal" && !v.remote && v.network !== "direct" && !v.apps.includes(a))} onChange={(e) => app(a, e.target.checked)} /> {t(a)}</label>
            ))}
            {!v.remote && v.network !== "direct" && !v.apps.includes("terminal") && <p className="muted small">{t("Terminal: only for a computer that browses directly (its shell could read the proxy or VPN secret).")}</p>}
          </fieldset>
          {v.apps.includes("browser") && (
            <label>{t("Home page")}<input value={v.home ?? ""} disabled={dis} placeholder="https://www.google.com" onChange={(e) => set({ home: e.target.value || undefined })} /></label>
          )}
          {v.apps.includes("mcp") && (
            <fieldset>
              <legend>{t("Connectors it may call")}</legend>
              {p.connectors.length ? p.connectors.map((c) => (
                <label key={c.id} className="check-inline"><input type="checkbox" checked={v.connectors.includes(c.id)} disabled={dis} onChange={(e) => set({ connectors: e.target.checked ? [...v.connectors, c.id] : v.connectors.filter((x) => x !== c.id) })} /> {c.name}</label>
              )) : <span className="muted small">{t("This world has no connectors yet (Settings → Connectors).")}</span>}
            </fieldset>
          )}
          {v.apps.includes("stream") && (
            <label>{t("Video to play by default")}<input value={v.stream ?? ""} disabled={dis} placeholder="https://…/video.m3u8" onChange={(e) => set({ stream: e.target.value || undefined })} /></label>
          )}
          {v.apps.includes("camera") && (
            <fieldset>
              <legend>{t("Camera")}</legend>
              <label>{t("Feed (image, MJPEG or HLS)")}<input value={v.camera?.url ?? ""} disabled={dis} placeholder="https://" onChange={(e) => set({ camera: e.target.value ? { everySeconds: 60, ...v.camera, url: e.target.value } : undefined })} /></label>
              {v.camera && (
                <>
                  <label>{t("Look every (seconds)")}<input type="number" min={10} max={3600} value={v.camera.everySeconds} disabled={dis} onChange={(e) => set({ camera: { ...v.camera!, everySeconds: Math.min(3600, Math.max(10, Number(e.target.value) || 60)) } })} /></label>
                  <label>{t("Watch for")}<input value={v.camera.watchFor ?? ""} disabled={dis} placeholder={t("people arriving or anything unusual")} onChange={(e) => set({ camera: { ...v.camera!, watchFor: e.target.value || undefined } })} /></label>
                  <label>{t("Tell")}<select value={v.camera.notify ?? ""} disabled={dis} onChange={(e) => set({ camera: { ...v.camera!, notify: e.target.value || undefined } })}>
                    <option value="">{t("nobody (note it on the computer)")}</option>
                    {p.agents.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select></label>
                </>
              )}
            </fieldset>
          )}
          <label className="check">
            <input type="checkbox" checked={v.remote} disabled={dis} onChange={(e) => set({ remote: e.target.checked })} />
            <span><b>{t("Remote connect")}</b> <span className="muted small">{t("Run it on another machine (a PC of yours), so it does not take this server's resources. That machine only connects out to Agentown.")}</span></span>
          </label>
          {!v.remote ? (
            <fieldset>
              <legend>{t("Network")}</legend>
              {(["direct", "proxy", "vpn"] as const).map((n) => (
                <label key={n} className="check-inline"><input type="radio" name="computer-network" checked={v.network === n} disabled={dis || (n !== "direct" && v.apps.includes("terminal"))} onChange={() => set({ network: n })} /> {t({ direct: "Direct", proxy: "Proxy", vpn: "VPN (WireGuard)" }[n])}</label>
              ))}
              {v.apps.includes("terminal") && <p className="muted small">{t("With the terminal app it browses directly: a shell in it could read a proxy or VPN secret.")}</p>}
              {v.network !== "direct" && (
                p.saved.network !== v.network || !p.saved.studio ? <p className="muted small">{t("Save first, then set its address here.")}</p>
                : p.owner ? (
                  <div className="computer-secret">
                    {v.network === "proxy"
                      ? <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="http://user:pass@host:port · socks5://host:port" autoComplete="off" />
                      : <textarea rows={6} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={"[Interface]\nPrivateKey = …\nAddress = …\n[Peer]\nPublicKey = …\nEndpoint = …"} spellCheck={false} />}
                    <div className="btn-row">
                      <button type="button" className="primary" disabled={busy || !secret.trim()} onClick={() => void call("PUT", "/network", { secret }).then((r) => r && setSecret(""))}>{t("Save and restart")}</button>
                      {s?.network?.secretSet && <button type="button" disabled={busy} onClick={() => void call("PUT", "/network", { secret: null })}>{t("Remove")}</button>}
                      <span className="muted small">{s?.network?.secretSet ? t("set (kept sealed; never shown again)") : t("not set: it browses directly")}</span>
                    </div>
                  </div>
                ) : <p className="muted small">{s?.network?.secretSet ? t("Set by the owner.") : t("Only the owner sets it.")}</p>
              )}
            </fieldset>
          ) : (
            <fieldset>
              <legend>{t("Paired machine")}</legend>
              {!p.saved.remote ? <p className="muted small">{t("Save first, then connect a machine.")}</p> : (
                <>
                  <ComputerHealth objectId={p.objectId} />
                  {pairing ? (
                    <div className="computer-pair">
                      <p className="small">{t("On the other machine (Linux, or macOS with Docker), run once in a terminal:")}</p>
                      <code className="pair-command" onClick={() => void navigator.clipboard?.writeText(pairing.command).then(() => p.notify(t("Copied"), "info"))}>{pairing.command}</code>
                      <p className="muted small">{t("Works once, until {time}. It installs Docker if missing, starts the computer there and remembers its key: no pairing again later.", { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</p>
                      <PairReach routes={pairing.routes ?? []} />
                      {pairing.temporary && <p className="muted small">{t("The link is on a temporary address of its own (no domain needed); it closes once the machine is paired or the link expires.")}</p>}
                    </div>
                  ) : null}
                  <div className="btn-row">
                    <button type="button" className="primary" disabled={busy || dis} onClick={() => void call("POST", "/pair").then((r) => r && setPairing(r))}>{s?.remote?.machine ? t("Pair another machine") : t("Connect a machine")}</button>
                    {s?.remote?.machine && <button type="button" disabled={busy || dis} onClick={() => void call("DELETE", "/pair").then(() => setPairing(null))}>{t("Forget machine")}</button>}
                  </div>
                </>
              )}
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}
