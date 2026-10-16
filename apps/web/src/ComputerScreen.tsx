import { useEffect, useRef, useState } from "react";
import { api, orgPath } from "./api.ts";
import { t } from "./i18n.ts";

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
export function ComputerScreen({ objectId, notify }: { objectId: string; notify: (msg: string, kind?: "error" | "info") => void }) {
  const [status, setStatus] = useState<Status>({ state: "starting", detail: null });
  const [page, setPage] = useState({ url: "", title: "", tabs: 1 });
  const [address, setAddress] = useState("");
  const [editing, setEditing] = useState(false);
  const [big, setBig] = useState(false);
  const [typed, setTyped] = useState("");
  /** Bumped to connect again (turning it back on). */
  const [session, setSession] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const img = useRef<HTMLImageElement>(null);
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
      ws.current = sock;
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data as string);
        if (m.t === "frame") {
          if (img.current) img.current.src = `data:image/jpeg;base64,${m.data}`;
          if (m.w && m.h && (m.w !== size.current.w || m.h !== size.current.h)) {
            size.current = { w: m.w, h: m.h };
            setAspect(`${m.w} / ${m.h}`);
          }
        } else if (m.t === "page") setPage({ url: m.url, title: m.title, tabs: m.tabs });
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
  /** Where on the page (CSS pixels of the computer's viewport) a pointer event is. */
  const at = (e: { clientX: number; clientY: number }) => {
    // The picture may be letterboxed (full screen keeps its proportions).
    const r = img.current!.getBoundingClientRect();
    const { w, h } = size.current;
    const k = Math.min(r.width / w, r.height / h);
    const left = r.left + (r.width - w * k) / 2;
    const top = r.top + (r.height - h * k) / 2;
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
  return (
    <section className={`computer ${big ? "computer-big" : ""}`} aria-label={t("Computer screen")}>
      <div className="computer-bar">
        <button type="button" className="icon-btn" disabled={!on} onClick={() => send({ t: "back" })} aria-label={t("Back")} title={t("Back")}>
          ←
        </button>
        <button type="button" className="icon-btn" disabled={!on} onClick={() => send({ t: "forward" })} aria-label={t("Forward")} title={t("Forward")}>
          →
        </button>
        <button type="button" className="icon-btn" disabled={!on} onClick={() => send({ t: "reload" })} aria-label={t("Reload")} title={t("Reload")}>
          ⟳
        </button>
        <form
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
        </form>
        <button type="button" className="icon-btn" onClick={() => setBig(!big)} aria-label={big ? t("Smaller") : t("Full screen")} title={big ? t("Smaller") : t("Full screen")}>
          {big ? "⤡" : "⤢"}
        </button>
      </div>
      <div
        className="computer-screen"
        style={big ? undefined : { aspectRatio: aspect }}
        role="application"
        aria-label={t("Screen of the computer: click to use it, type to send keys")}
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.preventDefault();
          field.current?.focus({ preventScroll: true });
          if (!on || !img.current) return;
          send({ t: "mouse", type: "mousePressed", ...at(e), button: button(e.button), clickCount: e.detail || 1, modifiers: mods(e) });
        }}
        onPointerUp={(e) => on && img.current && send({ t: "mouse", type: "mouseReleased", ...at(e), button: button(e.button), clickCount: e.detail || 1, modifiers: mods(e) })}
        onPointerMove={(e) => {
          const now = Date.now();
          if (!on || !img.current || now - lastMove.current < 50) return;
          lastMove.current = now;
          send({ t: "mouse", type: "mouseMoved", ...at(e), modifiers: mods(e) });
        }}
        onWheel={(e) => on && img.current && send({ t: "wheel", ...at(e), dx: e.deltaX, dy: e.deltaY })}
      >
        <img ref={img} alt="" draggable={false} className={on ? "" : "hidden"} />
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
        <span>{on ? (page.url === "about:blank" || !page.title ? t("Blank page") : page.title) : t(STATE[status.state])}</span>
        {page.tabs > 1 && <span>· {t("{n} tabs", { n: page.tabs })}</span>}
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
