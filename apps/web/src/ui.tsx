import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { t as tr } from "./i18n.ts";
import { t } from "./i18n.ts";

export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return t("never");
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 5) return t("just now");
  if (s < 60) return t("{n}s ago", { n: s });
  if (s < 3600) return t("{n}m ago", { n: Math.floor(s / 60) });
  if (s < 172800) return t("{n}h ago", { n: Math.floor(s / 3600) });
  return t("{n}d ago", { n: Math.floor(s / 86400) });
}

const TONE: Record<string, string> = {
  idle: "neutral",
  thinking: "info",
  executing: "good",
  waiting: "info",
  blocked: "bad",
  offline: "muted",
  error: "bad",
  running: "good",
  pending: "warn",
  restarting: "warn",
  failed: "bad",
  stopped: "muted",
  none: "muted",
  unknown: "warn",
  queued: "muted",
  assigned: "neutral",
  in_progress: "info",
  review: "warn",
  done: "good",
  cancelled: "muted",
  succeeded: "good",
  lost: "warn",
  applied: "good",
  approved: "good",
  rejected: "muted",
  applying: "info",
  withdrawn: "muted",
  expired: "muted",
  uncertain: "warn",
};

export function StatusPill({ state }: { state: string }) {
  return <span className={`pill pill-${TONE[state] ?? "neutral"}`}>{t(state.replace("_", " "))}</span>;
}

export function describeScope(scope: { kind: string; ids?: string[] }): string {
  return scope.ids ? `${scope.kind}: ${scope.ids.join(", ")}` : scope.kind;
}

/** Open modals, newest last: only the top one answers Escape and keeps Tab inside it (a confirm over an editor). */
const openModals: object[] = [];

export function Modal({ title, onClose, children, wide, className = "", style }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; className?: string; style?: CSSProperties }) {
  const dialog = useRef<HTMLDivElement>(null);
  const me = useRef({}).current;
  useLayoutEffect(() => {
    openModals.push(me);
    return () => {
      openModals.splice(openModals.indexOf(me), 1);
    };
  }, [me]);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const trap = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !dialog.current || openModals.at(-1) !== me) return;
      const nodes = [...dialog.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')].filter(n => n.getClientRects().length);
      const first = nodes[0], last = nodes.at(-1);
      if (e.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
    };
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    window.addEventListener("keydown", trap);
    return () => { window.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openModals.at(-1) === me && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, me]);
  return (
    <div className="modal-backdrop" style={style} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className={`modal ${wide ? "wide" : ""} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label={tr("Close")}>
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export interface MenuItem {
  label: string;
  hint?: string;
  onSelect: () => void;
  danger?: boolean;
}

/** A button that opens a small menu; closes on a pick, a click outside, or Escape. */
export function Menu({ trigger, items, label, align = "right", header }: { trigger: ReactNode; items: MenuItem[]; label: string; align?: "left" | "right"; header?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);
  return (
    <div className="menu" ref={box}>
      <button type="button" className="menu-trigger" aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div className={`menu-list ${align}`} role="menu">
          {header && <div className="menu-header">{header}</div>}
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={it.danger ? "danger" : ""}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
