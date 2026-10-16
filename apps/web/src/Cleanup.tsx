import { type CleanerSettings, cleanerSettingsSchema, type TrashSettings, trashSettingsSchema } from "@agentown/core/world";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api.ts";
import { askConfirm } from "./dialogs.tsx";
import { t } from "./i18n.ts";

type Notify = (msg: string, kind?: "error" | "info") => void;
type Part = "workspace" | "downloads" | "history" | "chats" | "assets";
interface Item { id: string; part: Part; label: string; count: number; bytes: number; trashedAt: string }
interface Run { id: string; kind: "sweep" | "empty"; by: string; startedAt: string; finishedAt: string | null; report: Record<string, any>; error: string | null }
interface Report { parts: Record<Part, { count: number; bytes: number }>; skipped: string[] }

const PARTS: Array<{ id: Part; name: string; hint: string }> = [
  { id: "workspace", name: "Task outputs", hint: "finished tasks' folders in team workspaces, and retired members' folders" },
  { id: "downloads", name: "Downloads & browser cache", hint: "on the world's computers; logins stay" },
  { id: "history", name: "History", hint: "activity, logs, team messages, finished proposals, files of finished runs (never the audit log)" },
  { id: "chats", name: "Archived chats", hint: "chats archived that long ago" },
  { id: "assets", name: "Unused art", hint: "models and textures no object uses" },
];
const DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export const size = (b: number) => (b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${(b / 1024).toFixed(0)} KB` : b < 1024 ** 3 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${(b / 1024 ** 3).toFixed(2)} GB`);

function useCleanup() {
  const [v, setV] = useState<{ items: Item[]; runs: Run[] } | null>(null);
  const reload = useCallback(() => void api<{ items: Item[]; runs: Run[] }>("GET", "/api/cleanup").then(setV).catch(() => {}), []);
  useEffect(reload, [reload]);
  return [v, reload] as const;
}

/** When it runs: a time, some weekdays, in the setter's time zone. */
function ScheduleRow(p: { value: { at: string; days: number[]; timeZone: string }; disabled: boolean; onChange: (v: { at: string; days: number[]; timeZone: string }) => void }) {
  const v = p.value;
  const set = (x: Partial<typeof v>) => p.onChange({ ...v, ...x, timeZone: here() });
  return (
    <div className="form-row cleanup-schedule">
      <input type="time" value={v.at} disabled={p.disabled} aria-label={t("Time")} onChange={(e) => e.target.value && set({ at: e.target.value })} />
      <span className="cleanup-days" role="group" aria-label={t("Days")}>
        {DAYS.map((d, i) => (
          <label key={d} className="check">
            <input type="checkbox" checked={v.days.includes(i)} disabled={p.disabled || (v.days.length === 1 && v.days.includes(i))}
              onChange={(e) => set({ days: e.target.checked ? [...v.days, i].sort() : v.days.filter((x) => x !== i) })} />
            {t(d)}
          </label>
        ))}
      </span>
      <small className="muted">{v.timeZone}</small>
    </div>
  );
}

const when = (s: string) => new Date(s).toLocaleString();

/** The cleaning robot's settings, a preview of its next sweep, and its last sweeps. */
export function CleanerConfig(p: { value: Partial<CleanerSettings> | undefined; canEdit: boolean; onChange: (v: CleanerSettings) => void; notify: Notify }) {
  const v = cleanerSettingsSchema.parse(p.value ?? {});
  const [data, reload] = useCleanup();
  const [preview, setPreview] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const dis = !p.canEdit;
  const run = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api<Report>("POST", "/api/cleanup/sweep", { dryRun });
      if (dryRun) setPreview(r);
      else {
        setPreview(null);
        const n = Object.values(r.parts).reduce((a, x) => a + x.count, 0);
        p.notify(t("Swept {n} items into the trash", { n }), "info");
      }
    } catch (e) {
      p.notify((e as Error).message, "error");
    } finally {
      setBusy(false);
      reload();
    }
  };
  const sweeps = (data?.runs ?? []).filter((r) => r.kind === "sweep").slice(0, 5);
  return (
    <section className="computer-config cleanup-config">
      <label className="check">
        <input type="checkbox" checked={v.enabled} disabled={dis} onChange={(e) => p.onChange({ ...v, enabled: e.target.checked })} />
        <span><b>{t("Sweep on a schedule")}</b> <span className="muted small">{t("Moves what is old enough into the trash can, where it waits until the trash is emptied.")}</span></span>
      </label>
      <ScheduleRow value={v.schedule} disabled={dis || !v.enabled} onChange={(schedule) => p.onChange({ ...v, schedule })} />
      <h4>{t("What it sweeps")}</h4>
      {PARTS.map((x) => (
        <div key={x.id} className="form-row cleanup-part">
          <label className="check">
            <input type="checkbox" checked={v[x.id].enabled} disabled={dis} onChange={(e) => p.onChange({ ...v, [x.id]: { ...v[x.id], enabled: e.target.checked } })} />
            <span><b>{t(x.name)}</b> <span className="muted small">{t(x.hint)}</span></span>
          </label>
          <label className="cleanup-age">
            {t("older than")}
            <input type="number" min={1} max={3650} value={v[x.id].days} disabled={dis || !v[x.id].enabled}
              onChange={(e) => p.onChange({ ...v, [x.id]: { ...v[x.id], days: Math.max(1, Math.round(Number(e.target.value) || 1)) } })} />
            {t("days")}
          </label>
        </div>
      ))}
      <div className="btn-row">
        <button type="button" disabled={busy || dis} onClick={() => void run(true)}>{t("Preview")}</button>
        <button type="button" className="primary" disabled={busy || dis} onClick={() => void run(false)}>{t("Sweep now")}</button>
      </div>
      {preview && (
        <div className="review-box">
          <p className="small">{t("A sweep now would take:")}</p>
          <ul className="small">
            {PARTS.map((x) => <li key={x.id}>{t(x.name)}: {preview.parts[x.id].count} · {size(preview.parts[x.id].bytes)}</li>)}
          </ul>
          {preview.skipped.length > 0 && <p className="muted small">{t("Not reachable now: {list}", { list: preview.skipped.join("; ") })}</p>}
        </div>
      )}
      {sweeps.length > 0 && (
        <>
          <h4>{t("Last sweeps")}</h4>
          <ul className="small cleanup-runs">
            {sweeps.map((r) => {
              const parts = (r.report.parts ?? {}) as Report["parts"];
              const n = Object.values(parts).reduce((a, x) => a + x.count, 0);
              const b = Object.values(parts).reduce((a, x) => a + x.bytes, 0);
              return <li key={r.id}>{when(r.startedAt)} · {r.by === "schedule" ? t("on schedule") : t("by hand")} · {t("{n} items", { n })} · {size(b)}{r.error ? ` · ${r.error}` : ""}</li>;
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/** The trash can: when it empties itself, what waits in it (each can go back), and emptying now. */
export function TrashConfig(p: { value: Partial<TrashSettings> | undefined; canEdit: boolean; onChange: (v: TrashSettings) => void; notify: Notify }) {
  const v = trashSettingsSchema.parse(p.value ?? {});
  const [data, reload] = useCleanup();
  const [busy, setBusy] = useState(false);
  const dis = !p.canEdit;
  const call = async (path: string, done: string) => {
    setBusy(true);
    try {
      await api("POST", `/api/cleanup/${path}`, {});
      p.notify(done, "info");
    } catch (e) {
      p.notify((e as Error).message, "error");
    } finally {
      setBusy(false);
      reload();
    }
  };
  const items = data?.items ?? [];
  const total = items.reduce((a, x) => a + x.bytes, 0);
  return (
    <section className="computer-config cleanup-config">
      <label className="check">
        <input type="checkbox" checked={v.enabled} disabled={dis} onChange={(e) => p.onChange({ ...v, enabled: e.target.checked })} />
        <span><b>{t("Empty on a schedule")}</b> <span className="muted small">{t("Deletes for good what has been in the trash long enough.")}</span></span>
      </label>
      <ScheduleRow value={v.schedule} disabled={dis || !v.enabled} onChange={(schedule) => p.onChange({ ...v, schedule })} />
      <label className="cleanup-age">
        {t("Keep things in the trash at least")}
        <input type="number" min={0} max={3650} value={v.keepDays} disabled={dis} onChange={(e) => p.onChange({ ...v, keepDays: Math.max(0, Math.round(Number(e.target.value) || 0)) })} />
        {t("days")}
      </label>
      <h4>{t("In the trash")} · {size(total)}</h4>
      {items.length === 0 ? (
        <p className="muted small">{t("The trash is empty.")}</p>
      ) : (
        <ul className="cleanup-items">
          {items.map((x) => (
            <li key={x.id}>
              <span className="small"><b>{x.label}</b> · {t("{n} items", { n: x.count })} · {size(x.bytes)} · {when(x.trashedAt)}</span>
              <button type="button" disabled={busy || dis} onClick={() => void call(`items/${encodeURIComponent(x.id)}/restore`, t("Put back"))}>{t("Restore")}</button>
            </li>
          ))}
        </ul>
      )}
      <div className="btn-row">
        <button type="button" className="danger" disabled={busy || dis || !items.length}
          onClick={async () => (await askConfirm(t("Delete everything in the trash for good? It cannot be put back."), { danger: true })) && void call("empty", t("Trash emptied"))}>
          {t("Empty now")}
        </button>
      </div>
    </section>
  );
}
