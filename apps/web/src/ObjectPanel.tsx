import { canTalk, chatTemplateOf, FINISHES, objectState, SHAPES, type World } from "@agentown/core/world";
import { addPart, duplicatePart, kindColors, recolorKind, removePart, updatePart } from "./office3d/kindEdit.ts";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import type { Agent, Snapshot, WorkState } from "./types.ts";
import { Avatar, WhoName } from "./Avatar.tsx";
import { uploadAsset } from "./Assets.tsx";
import { ColorInput, StatusPill } from "./ui.tsx";
import { ComputerScreen } from "./ComputerScreen.tsx";
import { deskStates } from "./office3d/live.ts";

const ObjectStudio = lazy(() => import("./office3d/ObjectStudio.tsx"));

type Kind = World["kinds"][string];
type Placed = World["objects"][number];

const BEHAVIOR: Record<string, string> = {
  spin: "turns",
  bob: "bobs up and down",
  pulse: "pulses to the beat",
  blink: "blinks",
  flicker: "glows softly",
  sway: "sways",
  rock: "rocks",
  steam: "steams",
  wander: "wanders around where it stands",
  roam: "walks between rooms",
};
const CATEGORY: Record<string, string> = { character: "Character", static: "Furniture", dynamic: "Moving object" };

type PanelProps = {
  objectId: string;
  snapshot: Snapshot;
  canDesign: boolean;
  /** The owner: may have objects do things, and ask agents to. */
  owner: boolean;
  workOf: (a: Agent) => WorkState;
  onChat?: (id: string, name: string) => void;
  onSelectAgent: (id: string) => void;
  /** Open a conversation this object came up in. */
  onOpenChat?: (target: { type: "agent" | "object"; id: string; name: string } | null, chatId: string) => void;
  onClose: () => void;
  notify: (msg: string, kind?: "error" | "info") => void;
};

/** A placed object, or someone's workstation ("desk:<agent id>"). */
export function ObjectPanel(p: PanelProps) {
  return p.objectId.startsWith("desk:") ? <WorkstationPanel {...p} agentId={p.objectId.slice(5)} /> : <PlacedPanel {...p} />;
}

/** Re-render every `ms`, for things that change with time (an object's own rhythm). */
function useTick(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

const DESK: Record<string, string> = { off: "Off", sleep: "Asleep", on: "On", working: "Working" };

/**
 * A workstation is its own thing: it wakes when its person sits down, works
 * while they work, sleeps when they walk off and is off while they are offline.
 */
function WorkstationPanel(p: PanelProps & { agentId: string }) {
  useTick(1000);
  const agent = p.snapshot.agents.find((a) => a.id === p.agentId);
  if (!agent) return null;
  const work = p.workOf(agent);
  // As the office shows it (whether they sit at it); before the office has drawn it, from their work alone.
  const state = deskStates.get(agent.id) ?? (work === "offline" ? "off" : work === "executing" || work === "thinking" ? "working" : "on");
  const room = p.snapshot.departments.find((d) => d.id === agent.departmentId)?.name;
  return (
    <aside className="panel agent-panel object-panel" aria-label={t("Workstation of {name}", { name: agent.displayName })}>
      <header className="panel-head">
        <div className="avatar object-avatar" aria-hidden>
          ▣
        </div>
        <div className="panel-title">
          <h2>{t("Workstation of {name}", { name: agent.displayName })}</h2>
          <div className="muted">{[t("Desk and computer"), room].filter(Boolean).join(" · ")}</div>
        </div>
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t("Close panel")}>
          ×
        </button>
      </header>
      <div className="panel-body">
        <section className="studio">
          <Suspense fallback={<div className="studio-stage studio-loading" />}>
            <ObjectStudio scale={1} workstation={{ state, runtime: agent.runtime?.state ?? "none" }} />
          </Suspense>
        </section>
        <section className="kv">
          <div>{t("State")}</div>
          <div>
            <span className={`desk-state desk-${state}`}>{t(DESK[state]!)}</span>
          </div>
          <div>{t("Belongs to")}</div>
          <div>
            <button type="button" className="link who-link" onClick={() => p.onSelectAgent(agent.id)}>
              <Avatar who={{ type: "agent", id: agent.id }} size={22} /> {agent.displayName}
            </button>{" "}
            <StatusPill state={work} />
          </div>
          <div>{t("Runtime")}</div>
          <div>{agent.runtime?.state ?? t("none")}</div>
          <div>{t("Can")}</div>
          <div>{t("nothing on its own: it wakes when {name} sits down to work, sleeps when they walk away and turns off while they are offline.", { name: agent.displayName })}</div>
        </section>
      </div>
    </aside>
  );
}

/**
 * A placed object: the model in its own studio, what it is doing and what
 * can be done with it, and (for people who may design the world) its name,
 * placement, colors, picture and whether it talks. Furniture that does not
 * talk has no chat at all.
 */
function PlacedPanel(p: PanelProps) {
  const world = p.snapshot.world;
  const saved = world?.objects.find((o) => o.id === p.objectId);
  const [draft, setDraft] = useState<{ object: Placed; kind: Kind } | null>(null);
  const [walking, setWalking] = useState(false);
  const [part, setPart] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [lookOpen, setLookOpen] = useState(false);
  const [doer, setDoer] = useState<Record<string, string>>({});
  const [refs, setRefs] = useState<Array<{ chatId: string; title: string; subject: { type: "owner" | "agent" | "object"; id: string } }>>([]);
  const clock = useTick(1000);
  // The conversations it came up in (asked, used, named): the owner can open them.
  useEffect(() => {
    if (!p.owner) return;
    let live = true;
    api<{ refs: typeof refs }>("GET", `/api/object-refs/${encodeURIComponent(p.objectId)}`).then((r) => live && setRefs(r.refs)).catch(() => {});
    return () => {
      live = false;
    };
  }, [p.objectId, p.owner, p.snapshot.objectStates]);
  useEffect(() => {
    setDraft(null);
    setWalking(false);
    setPart(null);
    setPreview(null);
    setLookOpen(false);
  }, [p.objectId]);
  const object = draft?.object ?? saved;
  const kind = draft?.kind ?? (saved ? world?.kinds[saved.kind] : undefined);
  const colors = useMemo(() => (kind ? kindColors(kind) : []), [kind]);
  if (!world || !object || !kind || !saved) return null;
  const room = world.floors.flatMap((f) => f.rooms).find((r) => r.id === object.room);
  const name = object.label || kind.name;
  const talks = canTalk(world, object);
  const roams = kind.behaviors.some((b) => b.type === "roam");
  const behaviors = [...new Set(kind.behaviors.map((b) => t(BEHAVIOR[b.type] ?? b.type)))];
  const changed = !!draft && (JSON.stringify(draft.object) !== JSON.stringify(saved) || JSON.stringify(draft.kind) !== JSON.stringify(world.kinds[saved.kind]));
  const others = world.objects.filter((o) => o.kind === saved.kind).length - 1;
  const access = kind.access;
  const activity = (p.snapshot.objectStates ?? []).find((x) => x.objectId === p.objectId && Date.parse(x.until) > clock);
  const current = objectState(kind, p.objectId, clock, activity ? { state: activity.state, until: Date.parse(activity.until) } : null);
  const shown = (preview ? kind.states.find((x) => x.id === preview) : current) ?? null;
  const people = p.snapshot.agents.filter((a) => a.lifecycleState !== "retired");
  const act = async (action: string, agentId?: string) => {
    setBusy(true);
    try {
      await api("POST", `/api/objects/${encodeURIComponent(p.objectId)}/actions`, { action, ...(agentId ? { agentId } : {}) });
      setPreview(null);
    } catch (e) {
      p.notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };
  const where =
    access === "all" ? t("every room") : access === "own-room" ? t("its own room") : access === "own-department" ? t("its department's rooms") : "zone" in access ? t("zone {zone}", { zone: access.zone }) : access.rooms.map((id) => world.floors.flatMap((f) => f.rooms).find((r) => r.id === id)?.name ?? id).join(", ");

  const edit = (o: Partial<Placed>, k?: Kind) => setDraft({ object: { ...object, ...o }, kind: k ?? kind });
  const recolor = (from: string, to: string) => edit({}, recolorKind(kind, from, to));
  const shape = (k: Kind) => edit({}, k);
  const parts = "parts" in kind.look ? kind.look.parts : null;
  const sel = parts && part != null ? parts[part] : undefined;
  const vec = (label: string, v: [number, number, number], set: (v: [number, number, number]) => void, min: number) => (
    <div className="vec3">
      <span>{label}</span>
      {v.map((n, j) => (
        <input key={j} type="number" step={0.05} min={min} max={20} value={n} aria-label={`${label} ${"xyz"[j]}`} onChange={(e) => set(v.map((x, k) => (k === j ? Math.max(min, Number(e.target.value) || 0) : x)) as [number, number, number])} />
      ))}
    </div>
  );
  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const cur = await api<{ revision: number; world: World }>("GET", "/api/world");
      const objects = cur.world.objects.map((o) => (o.id === p.objectId ? draft.object : o));
      await api("PUT", "/api/world", { revision: cur.revision, world: { ...cur.world, objects, kinds: { ...cur.world.kinds, [saved.kind]: draft.kind } } });
      setDraft(null);
      p.notify(t("{name} saved", { name: draft.object.label || draft.kind.name }), "info");
    } catch (e) {
      p.notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  // The fields people change most, shared by the editor over the model and the full editor below.
  const basics = (
    <div className="look-grid">
      <label>
        {t("Name")}
        <input value={object.label ?? ""} maxLength={40} placeholder={kind.name} onChange={(e) => edit({ label: e.target.value || undefined })} />
      </label>
      <label>
        {t("Subtitle")}
        <input value={object.title ?? ""} maxLength={40} placeholder={kind.title ?? ""} onChange={(e) => edit({ title: e.target.value || undefined })} />
      </label>
      <label>
        {t("Turn")} · {object.rotationY}°
        <input type="range" min={-180} max={180} step={15} value={object.rotationY} onChange={(e) => edit({ rotationY: Number(e.target.value) })} />
      </label>
      <label>
        {t("Scale")} · ×{object.scale.toFixed(1)}
        <input type="range" min={0.5} max={2} step={0.1} value={object.scale} onChange={(e) => edit({ scale: Number(e.target.value) })} />
      </label>
    </div>
  );
  const palette = "character" in kind.look ? (
    <div className="look-grid">
      <label>
        {t("Main color")}
        <ColorInput value={kind.look.color ?? "#9aa3ad"} onChange={(v) => edit({}, { ...kind, look: { ...kind.look, color: v } as Kind["look"] })} />
      </label>
      <label>
        {t("Accent (hair, legs)")}
        <ColorInput value={("accent" in kind.look && kind.look.accent) || "#3b2a20"} onChange={(v) => edit({}, { ...kind, look: { ...kind.look, accent: v } as Kind["look"] })} />
      </label>
    </div>
  ) : (
    colors.length > 0 && (
                    <div className="swatches" aria-label={t("Colors")}>
                      {colors.map((c) => (
                        <ColorInput key={c} value={c} aria-label={c} onChange={(v) => recolor(c, v.toLowerCase())} />
                      ))}
                    </div>
                  )
  );
  const saveBar = (
    <div className="btn-row">
      <button type="button" className="primary" disabled={!changed || busy} onClick={() => void save()}>
        {t("Save")}
      </button>
      {changed && (
        <button type="button" disabled={busy} onClick={() => setDraft(null)}>
          {t("Cancel")}
        </button>
      )}
    </div>
  );

  return (
    <aside className="panel agent-panel object-panel" aria-label={name}>
      <header className="panel-head">
        <Avatar who={{ type: "object", id: p.objectId }} size={40} />
        <div className="panel-title">
          <h2>{name}</h2>
          <div className="muted">
            {object.title ?? kind.title ?? kind.name} · {room?.name ?? object.room}
          </div>
        </div>
        {talks && p.onChat && (
          <button type="button" className="primary tab-chat" onClick={() => p.onChat!(p.objectId, name)}>
            {t("Chat")}
          </button>
        )}
        <button type="button" className="icon-btn" onClick={p.onClose} aria-label={t("Close panel")}>
          ×
        </button>
      </header>
      <div className="panel-body">
        {kind.browser && (p.owner || p.canDesign) && <ComputerScreen objectId={p.objectId} notify={p.notify} />}
        {kind.browser && !(p.owner || p.canDesign) && <p className="muted small">{t("A computer the agents use. Only the owner, and people who may design the world, see its screen.")}</p>}
        <section className={`studio ${kind.browser && (p.owner || p.canDesign) ? "studio-small" : ""}${lookOpen ? " preset-open" : ""}`}>
          <div className="studio-host">
            <Suspense fallback={<div className="studio-stage studio-loading" />}>
              <ObjectStudio kind={kind} scale={object.scale} walking={walking} state={shown} highlight={p.canDesign ? part : null} />
            </Suspense>
            {p.canDesign && (
              // Like an agent's look: edit it beside the model and save right there.
              <aside className={`studio-preset${lookOpen ? " open" : ""}`} aria-label={t("Edit")}>
                <button type="button" className="studio-preset-toggle" aria-expanded={lookOpen} onClick={() => setLookOpen((x) => !x)}>
                  {lookOpen ? `${t("Edit")} ›` : `‹ ${t("Edit")}`}
                </button>
                {lookOpen && (
                  <div className="studio-preset-body">
                    {basics}
                    {palette}
                    {saveBar}
                  </div>
                )}
              </aside>
            )}
          </div>
          {kind.states.length > 0 && (
            <div className="state-chips" role="group" aria-label={t("Show the object")}>
              <button type="button" className={preview === null ? "active" : ""} onClick={() => setPreview(null)}>
                {t("Now")}
                {current ? ` · ${current.name}` : ""}
              </button>
              {kind.states.map((x) => (
                <button key={x.id} type="button" className={preview === x.id ? "active" : ""} onClick={() => (setPreview(x.id), setWalking(false))}>
                  {x.name}
                  {x.auto && <span className="muted" title={t("It does this by itself now and then")}> ↻</span>}
                </button>
              ))}
            </div>
          )}
          {roams && !kind.states.length && (
            <div className="btn-row studio-under">
              <button type="button" className={walking ? "" : "primary"} onClick={() => setWalking(false)}>
                {t("Resting")}
              </button>
              <button type="button" className={walking ? "primary" : ""} onClick={() => setWalking(true)}>
                {t("Walking around")}
              </button>
            </div>
          )}
        </section>

        {(current || kind.actions.length > 0) && (
          <section className="object-life">
            {current && (
              <p className="object-now">
                <span className="muted">{t("Now")}:</span> <b>{current.name}</b>
                {activity && (
                  <span className="muted small">
                    {" · "}
                    {activity.by.type === "agent" ? (
                      <>
                        <Avatar who={{ type: "agent", id: activity.by.id }} size={18} /> {people.find((a) => a.id === activity.by.id)?.displayName ?? activity.by.id}
                      </>
                    ) : activity.by.type === "object" ? t("by itself") : t("by you")}
                    {" · "}
                    {t("{n}s left", { n: Math.max(0, Math.round((Date.parse(activity.until) - clock) / 1000)) })}
                  </span>
                )}
              </p>
            )}
            {p.owner &&
              kind.actions.map((a) => (
                <div key={a.id} className="object-action">
                  <b>{a.name}</b>
                  {a.gesture !== "none" && (
                    <select value={doer[a.id] ?? ""} onChange={(e) => setDoer({ ...doer, [a.id]: e.target.value })} aria-label={t("Who does it")}>
                      <option value="">{t("You, from afar")}</option>
                      {people.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.displayName}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" className="primary" disabled={busy} onClick={() => void act(a.id, doer[a.id] || undefined)}>
                    {t("Do it")}
                  </button>
                </div>
              ))}
          </section>
        )}

        {refs.length > 0 && p.onOpenChat && (
          <section className="object-refs">
            <h3>{t("Mentioned in {n} other conversations", { n: refs.length })}</h3>
            {refs.map((r) => (
              <button key={r.chatId} type="button" className="chat-ref" onClick={() => p.onOpenChat!(r.subject.type === "owner" ? null : { type: r.subject.type, id: r.subject.id, name: "" }, r.chatId)}>
                <Avatar who={r.subject.type === "owner" ? { type: "system" } : { type: r.subject.type, id: r.subject.id }} size={20} />
                <span className="chat-ref-title">
                  <b>
                    <WhoName who={r.subject.type === "owner" ? { type: "system" } : { type: r.subject.type, id: r.subject.id }} />
                  </b>{" "}
                  · {r.title}
                </span>
              </button>
            ))}
          </section>
        )}

        <section className="kv">
          <div>{t("Kind")}</div>
          <div>
            {kind.name} <span className="muted small">· {t(CATEGORY[kind.category] ?? kind.category)}</span>
          </div>
          <div>{t("Room")}</div>
          <div>{room?.name ?? object.room}</div>
          <div>{t("Moves")}</div>
          <div>{behaviors.length ? behaviors.join(", ") : <span className="muted">{t("stays still")}</span>}</div>
          {roams && (
            <>
              <div>{t("May walk in")}</div>
              <div>{where}</div>
            </>
          )}
          <div>{t("Can")}</div>
          <div>
            {kind.browser
              ? t("browse the web for the agents (agentown browser {id}). Logins you make on its screen stay; it turns itself off when unused.", { id: p.objectId })
              : talks
              ? t("talk with the owner; it only knows its own room, changes only what it is doing itself, and suggests work to the CEO once the owner confirms")
              : kind.actions.length
                ? t("be used: {actions}. No chat, no access to anything else.", { actions: kind.actions.map((a) => a.name).join(", ") })
                : t("nothing: it is part of the room. No chat, no access to anything.")}
          </div>
        </section>

        {p.canDesign && (
          <section className="object-edit">
            <h3>{t("Edit")}</h3>
            <div className="avatar-setting">
              <Avatar who={{ type: "object", id: p.objectId }} size={44} />
              <div>
                <b>{t("Avatar")}</b>
                <span className="muted small">{object.image ? t("Uploaded picture") : t("Portrait of its 3D model")}</span>
                <span className="btn-row">
                  <label className="button">
                    {t("Upload…")}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      hidden
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (!file) return;
                        try {
                          edit({ image: (await uploadAsset(file)).id });
                        } catch (err) {
                          p.notify((err as Error).message, "error");
                        }
                      }}
                    />
                  </label>
                  {object.image && (
                    <button type="button" className="link" onClick={() => edit({ image: undefined })}>
                      {t("Use the 3D portrait")}
                    </button>
                  )}
                </span>
              </div>
            </div>
            {basics}
            {"character" in kind.look ? (
              palette
            ) : (
              parts && (
                <div className="shape-edit">
                  <div className="muted small">{others > 0 ? t("Look and shape: for every {kind} ({n} more in the world)", { kind: kind.name, n: others }) : t("Look and shape")}</div>
                  {!("character" in kind.look) && palette}
                  <div className="part-chips" role="listbox" aria-label={t("Parts")}>
                    {parts.map((x, i) => (
                      <button key={i} type="button" role="option" aria-selected={part === i} className={part === i ? "active" : ""} onClick={() => setPart(part === i ? null : i)}>
                        <span className="dot" style={{ background: x.color }} />
                        {x.part ?? `${t(x.shape)} ${i + 1}`}
                      </button>
                    ))}
                    <button type="button" className="add" onClick={() => { shape(addPart(kind)); setPart(parts.length); }}>
                      + {t("Part")}
                    </button>
                  </div>
                  {sel && part != null && (
                    <div className="part-form">
                      <div className="look-grid">
                        <label>
                          {t("Part shape")}
                          <select value={sel.shape} onChange={(e) => shape(updatePart(kind, part, { shape: e.target.value as typeof sel.shape }))}>
                            {SHAPES.map((x) => (
                              <option key={x} value={x}>
                                {t(x)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("Finish")}
                          <select value={sel.finish ?? "matte"} onChange={(e) => shape(updatePart(kind, part, { finish: e.target.value as typeof sel.finish }))}>
                            {FINISHES.map((x) => (
                              <option key={x} value={x}>
                                {t(x)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {t("Color")}
                          <ColorInput value={sel.color} onChange={(v) => shape(updatePart(kind, part, { color: v, ...(sel.emissive ? { emissive: v } : {}) }))} />
                        </label>
                        <label className="check">
                          <input type="checkbox" checked={!!sel.emissive} onChange={(e) => shape(updatePart(kind, part, { emissive: e.target.checked ? sel.color : undefined }))} />
                          {t("Glows")}
                        </label>
                      </div>
                      {vec(t("Dimensions"), sel.size, (v) => shape(updatePart(kind, part, { size: v })), 0.01)}
                      {vec(t("Position"), sel.offset, (v) => shape(updatePart(kind, part, { offset: v })), -20)}
                      {vec(t("Rotation"), sel.rotation, (v) => shape(updatePart(kind, part, { rotation: v })), -360)}
                      <div className="btn-row">
                        <button type="button" onClick={() => { shape(duplicatePart(kind, part)); setPart(part + 1); }}>
                          {t("Duplicate")}
                        </button>
                        <button type="button" className="danger" disabled={removePart(kind, part) === kind} onClick={() => { shape(removePart(kind, part)); setPart(null); }}>
                          {t("Delete")}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            )}
            <label className="check">
              <input type="checkbox" checked={canTalk(world, object)} onChange={(e) => edit({ chat: { ...object.chat, enabled: e.target.checked } })} />
              {t("Can be talked to")}
            </label>
            {canTalk(world, object) && chatTemplateOf(world, object) && (
              <details className="object-chat-field">
                <summary>{t("Chat template for “{title}”", { title: object.title ?? kind.title ?? "" })}</summary>
                <p className="muted small">{chatTemplateOf(world, object)!.instructions}</p>
              </details>
            )}
            {canTalk(world, object) && (
              <label>
                {t("Personality")}
                <textarea rows={3} maxLength={12000} value={object.chat?.instructions ?? ""} placeholder={kind.chat?.instructions ?? t("Optional personality or context for this object")} onChange={(e) => edit({ chat: { ...object.chat, instructions: e.target.value || undefined } })} />
              </label>
            )}
          </section>
        )}
        {changed && !lookOpen && <div className="save-bar">{saveBar}</div>}
      </div>
    </aside>
  );
}
