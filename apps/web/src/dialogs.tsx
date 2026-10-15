import { useEffect, useRef, useState } from "react";
import { t } from "./i18n.ts";
import { Modal } from "./ui.tsx";

/**
 * In-page stand-ins for confirm() and prompt(): some browsers hide or block
 * native dialogs. <DialogHost /> is rendered once at the root; anywhere else,
 * `if (!(await askConfirm("Delete it?", { danger: true }))) return;`.
 */

type Request =
  | { kind: "confirm"; message: string; danger?: boolean; okLabel?: string; resolve: (ok: boolean) => void }
  | { kind: "text"; message: string; initial: string; okLabel?: string; resolve: (text: string | null) => void };

let push: ((r: Request) => void) | null = null;
const early: Request[] = [];
const enqueue = (r: Request) => (push ? push(r) : early.push(r));

export function askConfirm(message: string, opts: { danger?: boolean; okLabel?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => enqueue({ kind: "confirm", message, ...opts, resolve }));
}

/** A line of text, or null when cancelled. */
export function askText(message: string, initial = "", opts: { okLabel?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => enqueue({ kind: "text", message, initial, ...opts, resolve }));
}

export function DialogHost() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    push = (r) => setQueue((q) => [...q, r]);
    if (early.length) setQueue((q) => [...q, ...early.splice(0)]);
    return () => {
      push = null;
    };
  }, []);
  const current = queue[0];
  useEffect(() => {
    if (current?.kind === "text") {
      setText(current.initial);
      // After the modal has focused its first button.
      requestAnimationFrame(() => field.current?.focus());
    }
  }, [current]);
  if (!current) return null;
  const settle = (ok: boolean) => {
    if (current.kind === "confirm") current.resolve(ok);
    else current.resolve(ok ? text : null);
    setQueue((q) => q.slice(1));
  };
  return (
    <Modal title={current.kind === "text" ? t("Add a note") : t("Please confirm")} onClose={() => settle(false)} className="ask-dialog">
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          settle(true);
        }}
      >
        <p className="ask-message">{current.message}</p>
        {current.kind === "text" && <textarea ref={field} value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} />}
        <div className="btn-row">
          <button type="button" onClick={() => settle(false)}>
            {t("Cancel")}
          </button>
          <button type="submit" className={current.kind === "confirm" && current.danger ? "danger" : "primary"}>
            {current.okLabel ?? t("OK")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
