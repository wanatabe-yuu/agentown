import { canTalk, FINISHES, SHAPES, type World } from "@agentown/core/world";
import { addPart, duplicatePart, kindColors, recolorKind, removePart, updatePart } from "./office3d/kindEdit.ts";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { api } from "./api.ts";
import { t } from "./i18n.ts";
import type { Snapshot } from "./types.ts";

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

/**
 * A placed object: the model in its own studio, what it is and what it can
 * do, and (for people who may design the world) its name, placement, colors
 * and whether it talks. Furniture that does not talk has no chat at all.
 */
export function ObjectPanel(p: {
  objectId: string;
  snapshot: Snapshot;
  canDesign: boolean;
  onChat?: (id: string, name: string) => void;
  onClose: () => void;
  notify: (msg: string, kind?: "error" | "info") => void;
}) {
  const world = p.snapshot.world;
  const saved = world?.objects.find((o) => o.id === p.objectId);
  const [draft, setDraft] = useState<{ object: Placed; kind: Kind } | null>(null);
  const [walking, setWalking] = useState(false);
  const [part, setPart] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft(null);
    setWalking(false);
    setPart(null);
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

  return (
    <aside className="panel agent-panel object-panel" aria-label={name}>
      <header className="panel-head">
        <div className="avatar object-avatar" aria-hidden>
          {name.slice(0, 1)}
        </div>
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
        <section className="studio">
          <Suspense fallback={<div className="studio-stage studio-loading" />}>
            <ObjectStudio kind={kind} scale={object.scale} walking={walking} highlight={p.canDesign ? part : null} />
          </Suspense>
          {roams && (
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
            {talks ? t("talk with the owner; it only knows its own room and can suggest tasks the owner confirms") : t("nothing: it is part of the room. No chat, no access to anything.")}
          </div>
        </section>

        {p.canDesign && (
          <section className="object-edit">
            <h3>{t("Edit")}</h3>
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
            {"character" in kind.look ? (
              <div className="look-grid">
                <label>
                  {t("Main color")}
                  <input type="color" value={kind.look.color ?? "#9aa3ad"} onChange={(e) => edit({}, { ...kind, look: { ...kind.look, color: e.target.value } as Kind["look"] })} />
                </label>
                <label>
                  {t("Accent (hair, legs)")}
                  <input type="color" value={("accent" in kind.look && kind.look.accent) || "#3b2a20"} onChange={(e) => edit({}, { ...kind, look: { ...kind.look, accent: e.target.value } as Kind["look"] })} />
                </label>
              </div>
            ) : (
              parts && (
                <div className="shape-edit">
                  <div className="muted small">{others > 0 ? t("Look and shape: for every {kind} ({n} more in the world)", { kind: kind.name, n: others }) : t("Look and shape")}</div>
                  {colors.length > 0 && (
                    <div className="swatches" aria-label={t("Colors")}>
                      {colors.map((c) => (
                        <input key={c} type="color" value={c} aria-label={c} onChange={(e) => recolor(c, e.target.value.toLowerCase())} />
                      ))}
                    </div>
                  )}
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
                          <input type="color" value={sel.color} onChange={(e) => shape(updatePart(kind, part, { color: e.target.value, ...(sel.emissive ? { emissive: e.target.value } : {}) }))} />
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
            {canTalk(world, object) && (
              <label>
                {t("Personality")}
                <textarea rows={3} maxLength={12000} value={object.chat?.instructions ?? ""} placeholder={kind.chat?.instructions ?? t("Optional personality or context for this object")} onChange={(e) => edit({ chat: { ...object.chat, instructions: e.target.value || undefined } })} />
              </label>
            )}
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
          </section>
        )}
      </div>
    </aside>
  );
}
