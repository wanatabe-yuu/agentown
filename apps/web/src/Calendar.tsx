import { type CalendarJob, jobTimeOn, type World } from "@agentown/core/world";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { Avatar, type Who, WhoName } from "./Avatar.tsx";
import { askConfirm } from "./dialogs.tsx";
import { lang, t } from "./i18n.ts";
import type { Agent } from "./types.ts";
import { Modal } from "./ui.tsx";

/**
 * The wall calendar: a month of every scheduled job in the organization. Each day
 * shows who has a job then; done ones keep a check. A day opens its jobs, where
 * new ones are put on the calendar (every week at a time per weekday, or once).
 */

type Notify = (msg: string, kind?: "error" | "info") => void;
type Status = "running" | "done" | "failed";
interface JobRow { id: string; builtin: "sweep" | "empty" | null; job: CalendarJob; createdBy: string | null; since: string }
interface Run { jobId: string; day: string; at: string; status: Status; taskId?: string | null; error?: string | null }
interface Entry { job: JobRow; time: string; run: Run | null; state: Status | "missed" | "planned" }

// Weeks start on Monday (T2 … CN); weekdays are 0 Sunday … 6 Saturday.
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const SHORT = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOf = (day: string) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const here = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const locale = () => lang;

/** Which jobs fall on a day, with what became of each. */
function entriesOn(day: string, jobs: JobRow[], runs: Run[], now: Date): Entry[] {
  const weekday = dateOf(day).getDay();
  const today = ymd(now);
  const clock = now.toTimeString().slice(0, 5);
  const out: Entry[] = [];
  for (const j of jobs) {
    const run = runs.find((r) => r.jobId === j.id && r.day === day) ?? null;
    const time = (j.job.enabled ? jobTimeOn(j.job.repeat, day, weekday) : null) ?? (run ? hhmm(run.at) : null);
    if (!time || (!run && day < j.since)) continue;
    const past = day < today || (day === today && time <= clock);
    out.push({ job: j, time, run, state: run ? run.status : past ? "missed" : "planned" });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

const whoOf = (j: CalendarJob): Who => ({ type: j.who.type, id: j.who.id });
const MARK: Record<Entry["state"], string> = { done: "✓", failed: "!", running: "…", missed: "", planned: "" };
const STATE: Record<Entry["state"], string> = { done: "Done", failed: "Failed", running: "Running", missed: "Did not run", planned: "Planned" };

function JobAvatar({ entry, size }: { entry: Entry; size: number }) {
  return (
    <span className={`cal-avatar cal-${entry.state}`} title={`${entry.time} · ${entry.job.job.title} · ${t(STATE[entry.state])}`}>
      <Avatar who={whoOf(entry.job.job)} size={size} />
      {MARK[entry.state] && <b className="cal-mark" aria-hidden>{MARK[entry.state]}</b>}
    </span>
  );
}

function repeatText(j: CalendarJob) {
  if (j.repeat.type === "once") return t("Once");
  const days = WEEK.filter((d) => (j.repeat as { times: Array<string | null> }).times[d]);
  return `${t("Every week")} · ${days.map((d) => t(SHORT[d]!)).join(", ")}`;
}

export function CalendarDialog(p: { world: World | null; agents: Agent[]; canEdit: boolean; notify: Notify; onClose: () => void; onOpenObject: (id: string) => void; onOpenTask: (id: string) => void }) {
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [data, setData] = useState<{ jobs: JobRow[]; runs: Run[] } | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const now = new Date();
  // Six weeks from the Monday on or before the 1st.
  const cells = useMemo(() => {
    const start = new Date(month);
    start.setDate(1 - ((month.getDay() + 6) % 7));
    return Array.from({ length: 42 }, (_, i) => ymd(new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)));
  }, [month]);
  const reload = useCallback(
    () => void api<{ jobs: JobRow[]; runs: Run[] }>("GET", `/api/calendar?from=${cells[0]}&to=${cells[41]}`).then(setData).catch((e) => p.notify((e as Error).message, "error")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cells],
  );
  useEffect(reload, [reload]);
  const shift = (n: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + n, 1));
  const title = month.toLocaleDateString(locale(), { month: "long", year: "numeric" });
  return (
    <Modal title={t("Calendar")} onClose={p.onClose} wide className="cal-modal">
      <div className="cal-head">
        <button type="button" onClick={() => shift(-1)} aria-label={t("Previous month")}>‹</button>
        <h3>{title}</h3>
        <button type="button" onClick={() => shift(1)} aria-label={t("Next month")}>›</button>
        <button type="button" onClick={() => setMonth(new Date(now.getFullYear(), now.getMonth(), 1))}>{t("Today")}</button>
      </div>
      <div className="cal-grid" role="grid" aria-label={title}>
        {WEEK.map((d) => <div key={d} className="cal-weekday" role="columnheader">{t(SHORT[d]!)}</div>)}
        {cells.map((c) => {
          const entries = data ? entriesOn(c, data.jobs, data.runs, now) : [];
          const other = dateOf(c).getMonth() !== month.getMonth();
          return (
            <button key={c} type="button" role="gridcell" className={`cal-day${other ? " other" : ""}${c === ymd(now) ? " today" : ""}`} onClick={() => setDay(c)}
              aria-label={`${dateOf(c).toLocaleDateString(locale(), { day: "numeric", month: "long" })}: ${t("{n} jobs", { n: entries.length })}`}>
              <span className="cal-num">{dateOf(c).getDate()}</span>
              <span className="cal-avatars">
                {entries.slice(0, 4).map((e) => <JobAvatar key={e.job.id} entry={e} size={22} />)}
                {entries.length > 4 && <span className="cal-more">+{entries.length - 4}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {day && data && (
        <DayDialog day={day} entries={entriesOn(day, data.jobs, data.runs, now)} {...p} onClose={() => setDay(null)} onChanged={reload} />
      )}
    </Modal>
  );
}

function DayDialog(p: { day: string; entries: Entry[]; world: World | null; agents: Agent[]; canEdit: boolean; notify: Notify; onClose: () => void; onChanged: () => void; onOpenObject: (id: string) => void; onOpenTask: (id: string) => void }) {
  const [form, setForm] = useState<JobRow | "new" | null>(null);
  const date = dateOf(p.day);
  const title = date.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const remove = async (j: JobRow) => {
    if (!(await askConfirm(t("Take “{title}” off the calendar? Every day it repeats goes with it.", { title: j.job.title }), { danger: true }))) return;
    try {
      await api("DELETE", `/api/schedules/${encodeURIComponent(j.id)}`);
      p.onChanged();
    } catch (e) {
      p.notify((e as Error).message, "error");
    }
  };
  if (form)
    return (
      <JobForm initial={form === "new" ? null : form} day={p.day} world={p.world} agents={p.agents} notify={p.notify} onClose={() => setForm(null)}
        onSaved={() => { setForm(null); p.onChanged(); }} />
    );
  return (
    <Modal title={title} onClose={p.onClose}>
      {p.entries.length === 0 ? (
        <div className="cal-empty">
          <p className="muted">{t("Nothing is scheduled on this day.")}</p>
        </div>
      ) : (
        <ul className="cal-list">
          {p.entries.map((e) => {
            const j = e.job;
            return (
              <li key={j.id}>
                <JobAvatar entry={e} size={36} />
                <div className="cal-entry">
                  <div><b>{e.time}</b> · {j.builtin ? t(j.job.title) : j.job.title}</div>
                  <div className="muted small">
                    <WhoName who={whoOf(j.job)} /> · {repeatText(j.job)} · <span className={`cal-state cal-${e.state}`}>{t(STATE[e.state])}</span>
                    {e.run?.error ? ` · ${e.run.error}` : ""}
                  </div>
                </div>
                <div className="btn-row">
                  {e.run?.taskId && <button type="button" onClick={() => p.onOpenTask(e.run!.taskId!)}>{t("Open task")}</button>}
                  {j.builtin ? (
                    <button type="button" onClick={() => p.onOpenObject(j.job.who.id)}>{t("Settings")}</button>
                  ) : p.canEdit ? (
                    <>
                      <button type="button" onClick={() => setForm(j)}>{t("Edit")}</button>
                      <button type="button" className="danger" onClick={() => void remove(j)}>{t("Delete")}</button>
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {p.canEdit && (
        <div className="btn-row cal-foot">
          <button type="button" className="primary" onClick={() => setForm("new")}>{t("Create schedule")}</button>
        </div>
      )}
    </Modal>
  );
}

/** A job: who does what, and when (every week at a time per weekday, or once). */
function JobForm(p: { initial: JobRow | null; day: string; world: World | null; agents: Agent[]; notify: Notify; onClose: () => void; onSaved: () => void }) {
  const world = p.world ?? { objects: [], kinds: {} as World["kinds"] };
  const objects = world.objects.filter((o) => o.id && world.kinds[o.kind]?.actions.length);
  const agents = p.agents.filter((a) => a.lifecycleState !== "retired");
  const first = objects[0] ? `object:${objects[0].id}` : agents[0] ? `agent:${agents[0].id}` : "";
  const init = p.initial?.job;
  const [title, setTitle] = useState(init?.title ?? "");
  const [who, setWho] = useState(init ? `${init.who.type}:${init.who.id}` : first);
  const [action, setAction] = useState(init?.action ?? "");
  const [prompt, setPrompt] = useState(init?.prompt ?? "");
  const [type, setType] = useState<"weekly" | "once">(init?.repeat.type ?? "weekly");
  const weekday = dateOf(p.day).getDay();
  const [times, setTimes] = useState<Array<string | null>>(init?.repeat.type === "weekly" ? init.repeat.times : Array.from({ length: 7 }, (_, i) => (i === weekday ? "09:00" : null)));
  // A one-off from a past day defaults to today.
  const [date, setDate] = useState(init?.repeat.type === "once" ? init.repeat.date : p.day < ymd(new Date()) ? ymd(new Date()) : p.day);
  const [at, setAt] = useState(init?.repeat.type === "once" ? init.repeat.at : "09:00");
  const [enabled, setEnabled] = useState(init?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [whoType, whoId] = who.split(":") as ["object" | "agent", string];
  const object = whoType === "object" ? world.objects.find((o) => o.id === whoId) : undefined;
  const actions = object ? world.kinds[object.kind]!.actions : [];
  const shownAction = actions.some((a) => a.id === action) ? action : (actions[0]?.id ?? "");
  const setTime = (d: number, v: string | null) => setTimes(times.map((x, i) => (i === d ? v : x)));
  const save = async () => {
    setBusy(true);
    const job = {
      title: title.trim() || (object ? `${object.label ?? world.kinds[object.kind]!.name}: ${actions.find((a) => a.id === shownAction)?.name ?? ""}` : prompt.trim().slice(0, 60)),
      who: { type: whoType, id: whoId },
      ...(whoType === "object" ? { action: shownAction } : { prompt: prompt.trim() }),
      repeat: type === "weekly" ? { type, times } : { type, date, at },
      timeZone: init?.timeZone ?? here(),
      enabled,
    };
    try {
      if (p.initial) await api("PUT", `/api/schedules/${encodeURIComponent(p.initial.id)}`, job);
      else await api("POST", "/api/schedules", job);
      p.onSaved();
    } catch (e) {
      p.notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const ready = !!whoId && (whoType === "object" ? !!shownAction : !!prompt.trim()) && (type === "once" ? !!date && !!at : times.some(Boolean));
  return (
    <Modal title={p.initial ? t("Edit schedule") : t("Create schedule")} onClose={p.onClose}>
      <form className="form cal-form" onSubmit={(e) => { e.preventDefault(); if (ready) void save(); }}>
        <label>
          {t("Who")}
          <select value={who} onChange={(e) => setWho(e.target.value)}>
            {objects.length > 0 && (
              <optgroup label={t("Objects")}>
                {objects.map((o) => <option key={o.id} value={`object:${o.id}`}>{o.label ?? world.kinds[o.kind]!.name}</option>)}
              </optgroup>
            )}
            {agents.length > 0 && (
              <optgroup label={t("Agents")}>
                {agents.map((a) => <option key={a.id} value={`agent:${a.id}`}>{a.displayName}</option>)}
              </optgroup>
            )}
          </select>
        </label>
        {whoType === "object" ? (
          <label>
            {t("Does")}
            <select value={shownAction} onChange={(e) => setAction(e.target.value)}>
              {actions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
        ) : (
          <label>
            {t("Task")}
            <textarea rows={3} maxLength={4000} value={prompt} placeholder={t("What should the agent do each time?")} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        )}
        <label>
          {t("Title")}
          <input value={title} maxLength={80} placeholder={t("Optional; shown on the calendar")} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <div className="tabs" role="tablist">
          {(["weekly", "once"] as const).map((x) => (
            <button key={x} type="button" role="tab" aria-selected={type === x} className={type === x ? "active" : ""} onClick={() => setType(x)}>
              {x === "weekly" ? t("Every week") : t("Once")}
            </button>
          ))}
        </div>
        {type === "weekly" ? (
          <div className="cal-week">
            {WEEK.map((d) => (
              <div key={d} className="cal-week-row">
                <label className="check">
                  <input type="checkbox" checked={!!times[d]} onChange={(e) => setTime(d, e.target.checked ? "09:00" : null)} />
                  {t(LONG[d]!)}
                </label>
                <input type="time" value={times[d] ?? ""} disabled={!times[d]} aria-label={t("Time on {day}", { day: t(LONG[d]!) })} onChange={(e) => e.target.value && setTime(d, e.target.value)} />
              </div>
            ))}
          </div>
        ) : (
          <div className="form-row">
            <input type="date" value={date} aria-label={t("Day")} onChange={(e) => setDate(e.target.value)} />
            <input type="time" value={at} aria-label={t("Time")} onChange={(e) => e.target.value && setAt(e.target.value)} />
          </div>
        )}
        <label className="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t("On")} <small className="muted">{init?.timeZone ?? here()}</small>
        </label>
        <div className="btn-row">
          <button type="button" onClick={p.onClose}>{t("Cancel")}</button>
          <button type="submit" className="primary" disabled={busy || !ready}>{t("Save")}</button>
        </div>
      </form>
    </Modal>
  );
}
