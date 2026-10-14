import { BEHAVIORS, CHARACTERS, checkWorld, SHAPES, type World, worldSchema } from "@agentown/core/world";
import { useState } from "react";
import { type AssetRow, uploadAsset, useAssets } from "../Assets.tsx";
import type { Department } from "../types.ts";

/** The world document as edited (the template's format). */
export type Draft = Record<string, any>;
type Tab = "objects" | "rooms" | "floors" | "kinds";
const ID = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;
const SIDES = ["north", "south", "east", "west"];

export interface EditorProps {
  draft: Draft;
  edit: (fn: (w: Draft) => void) => void;
  errors: string[];
  dirty: boolean;
  saving: boolean;
  selected: number | null;
  setSelected: (i: number | null) => void;
  roomId: string;
  setRoomId: (id: string) => void;
  mode: "translate" | "rotate";
  setMode: (m: "translate" | "rotate") => void;
  assets: AssetRow[];
  reloadAssets: () => Promise<void>;
  departments: Department[];
  jobRoles: string[];
  onSave: () => void;
  onDiscard: () => void;
  onUndo: () => void;
  canUndo: boolean;
  notify: (msg: string, kind?: "error" | "info") => void;
}

const rooms = (w: Draft): Array<{ floor: Draft; room: Draft }> => (w.floors ?? []).flatMap((floor: Draft) => (floor.rooms ?? []).map((room: Draft) => ({ floor, room })));
const findRoom = (w: Draft, id: string) => rooms(w).find((x) => x.room.id === id)?.room;
const freshId = (taken: string[], base: string) => {
  for (let i = 1; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
};

function Num({ value, onChange, step = 0.1, min, max, label }: { value: number | undefined; onChange: (v: number) => void; step?: number; min?: number; max?: number; label: string }) {
  return (
    <label className="num">
      <span>{label}</span>
      <input type="number" value={value ?? ""} step={step} min={min} max={max} onChange={(e) => e.target.value !== "" && onChange(Number(e.target.value))} aria-label={label} />
    </label>
  );
}

function Vec3({ value, onChange, label }: { value: number[] | undefined; onChange: (v: number[]) => void; label: string }) {
  const v = value ?? [0, 0, 0];
  return (
    <span className="vec3" title={label}>
      {[0, 1, 2].map((i) => (
        <input key={i} type="number" step={0.05} value={v[i] ?? 0} onChange={(e) => onChange(v.map((x, j) => (j === i ? Number(e.target.value) : x)))} aria-label={`${label} ${"xyz"[i]}`} />
      ))}
    </span>
  );
}

/** Side panel of the in-office world editor (org.design). The 3D view is where objects are moved and turned. */
export function WorldEditor(p: EditorProps) {
  const [tab, setTab] = useState<Tab>("objects");
  return (
    <aside className="world-editor" aria-label="World editor">
      <div className="btn-row">
        <button type="button" className="primary" disabled={!p.dirty || p.saving || p.errors.length > 0} onClick={p.onSave}>
          Save world
        </button>
        <button type="button" disabled={!p.canUndo} onClick={p.onUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={p.onDiscard}>
          {p.dirty ? "Discard" : "Close"}
        </button>
      </div>
      {p.errors.length > 0 && (
        <ul className="errors small">
          {p.errors.slice(0, 6).map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <nav className="tabs" role="tablist">
        {(["objects", "rooms", "floors", "kinds"] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "objects" && <ObjectsTab {...p} />}
      {tab === "rooms" && <RoomsTab {...p} />}
      {tab === "floors" && <FloorsTab {...p} />}
      {tab === "kinds" && <KindsTab {...p} />}
    </aside>
  );
}

function ObjectsTab(p: EditorProps) {
  const kinds = Object.entries(p.draft.kinds ?? {}) as Array<[string, Draft]>;
  const room = findRoom(p.draft, p.roomId);
  const obj = p.selected !== null ? p.draft.objects?.[p.selected] : null;
  const here = (p.draft.objects ?? []).map((o: Draft, i: number) => ({ o, i })).filter((x: { o: Draft }) => x.o.room === p.roomId);
  return (
    <section>
      <p className="muted small">Click an object in the office to select it, then drag the handles. Pick a room (list above the office, or click its floor) to add things to it.</p>
      <div className="seg-toggle" role="group" aria-label="Handle">
        <button type="button" className={p.mode === "translate" ? "active" : ""} onClick={() => p.setMode("translate")}>
          Move
        </button>
        <button type="button" className={p.mode === "rotate" ? "active" : ""} onClick={() => p.setMode("rotate")}>
          Turn
        </button>
      </div>
      {obj && (
        <div className="editor-card">
          <b>{p.draft.kinds?.[obj.kind]?.name ?? obj.kind}</b> <span className="muted small">in {obj.room}</span>
          <Num label="scale" value={obj.scale ?? 1} min={0.05} max={20} onChange={(v) => p.edit((w) => (w.objects[p.selected!].scale = v))} />
          <Num label="turn°" value={obj.rotationY ?? 0} step={15} onChange={(v) => p.edit((w) => (w.objects[p.selected!].rotationY = v))} />
          <label className="num">
            <span>label</span>
            <input value={obj.label ?? ""} maxLength={40} onChange={(e) => p.edit((w) => (w.objects[p.selected!].label = e.target.value || undefined))} />
          </label>
          <div className="btn-row">
            <button
              type="button"
              onClick={() =>
                p.edit((w) => {
                  const o = structuredClone(w.objects[p.selected!]);
                  o.at = [Math.min(o.at[0] + 0.5, findRoom(w, o.room)?.area.w ?? o.at[0]), o.at[1]];
                  w.objects.push(o);
                })
              }
            >
              Duplicate
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                p.edit((w) => w.objects.splice(p.selected!, 1));
                p.setSelected(null);
              }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
      <h4>Add to {room ? room.name : "…pick a room"}</h4>
      <div className="palette">
        {kinds.map(([id, k]) => (
          <button
            key={id}
            type="button"
            disabled={!room}
            aria-label={`Add ${k.name}`}
            title={`${k.category}${k.behaviors?.length ? ` · ${k.behaviors.map((b: Draft) => b.type).join(", ")}` : ""}`}
            onClick={() => {
              if (!room) return;
              p.edit((w) => (w.objects ??= []).push({ kind: id, room: room.id, at: [+(room.area.w / 2).toFixed(2), +(room.area.d / 2).toFixed(2)] }));
              p.setSelected(p.draft.objects?.length ?? 0);
            }}
          >
            {k.name}
          </button>
        ))}
        {kinds.length === 0 && <span className="muted small">No kinds yet: make one in the kinds tab.</span>}
      </div>
      {room && (
        <>
          <h4>In this room</h4>
          <ul className="task-list">
            {here.map(({ o, i }: { o: Draft; i: number }) => (
              <li key={i}>
                <button type="button" className={`task-row ${p.selected === i ? "active" : ""}`} onClick={() => p.setSelected(i)}>
                  {p.draft.kinds?.[o.kind]?.name ?? o.kind} {o.label && <span className="muted small">“{o.label}”</span>}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function RoomsTab(p: EditorProps) {
  const all = rooms(p.draft);
  const room = findRoom(p.draft, p.roomId);
  const textures = p.assets.filter((a) => a.kind === "texture");
  const set = (fn: (r: Draft) => void) => p.edit((w) => fn(findRoom(w, p.roomId)!));
  return (
    <section>
      <div className="form-row">
        <select value={p.roomId} onChange={(e) => p.setRoomId(e.target.value)} aria-label="Room">
          <option value="">Pick a room…</option>
          {all.map(({ floor, room: r }) => (
            <option key={r.id} value={r.id}>
              {floor.name} · {r.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const floor = all.find((x) => x.room.id === p.roomId)?.floor ?? p.draft.floors[0];
            const id = freshId(all.map((x) => x.room.id), "room");
            const east = Math.max(0, ...(floor.rooms ?? []).map((r: Draft) => r.area.x + r.area.w));
            p.edit((w) => w.floors.find((f: Draft) => f.id === floor.id).rooms.push({ id, name: "New room", area: { x: east + 1, z: 0, w: 8, d: 6 } }));
            p.setRoomId(id);
          }}
        >
          Add room
        </button>
      </div>
      {room && (
        <div className="editor-card">
          <label className="num wide">
            <span>name</span>
            <input value={room.name} maxLength={60} onChange={(e) => set((r) => (r.name = e.target.value))} />
          </label>
          <label className="num wide">
            <span>department</span>
            <select value={room.department ?? ""} onChange={(e) => set((r) => (r.department = e.target.value || undefined))}>
              <option value="">— none (agents do not sit here) —</option>
              {p.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <div className="nums">
            {(["x", "z", "w", "d"] as const).map((k) => (
              <Num key={k} label={k} value={room.area[k]} step={0.5} min={k === "w" || k === "d" ? 2 : -500} onChange={(v) => set((r) => (r.area[k] = v))} />
            ))}
            <Num label="wall m" value={room.wallHeight ?? 2.6} step={0.1} min={0.2} max={10} onChange={(v) => set((r) => (r.wallHeight = v))} />
            <Num label="seats" value={room.seats} step={1} min={0} onChange={(v) => set((r) => (r.seats = v))} />
          </div>
          <div className="nums">
            <label className="num">
              <span>floor</span>
              <input type="color" value={room.floorColor ?? "#e5e0d8"} onChange={(e) => set((r) => (r.floorColor = e.target.value))} />
            </label>
            <label className="num">
              <span>walls</span>
              <input type="color" value={room.wallColor ?? "#9aa3ad"} onChange={(e) => set((r) => (r.wallColor = e.target.value))} />
            </label>
            {(["floorTexture", "wallTexture"] as const).map((k) => (
              <label key={k} className="num">
                <span>{k === "floorTexture" ? "floor image" : "wall image"}</span>
                <select value={room[k] ?? ""} onChange={(e) => set((r) => (r[k] = e.target.value || undefined))}>
                  <option value="">none</option>
                  {textures.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <h4>Doors</h4>
          {(room.doors ?? []).map((d: Draft, i: number) => (
            <div key={i} className="form-row">
              <select value={d.side} onChange={(e) => set((r) => (r.doors[i].side = e.target.value))} aria-label="Wall">
                {SIDES.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
              <Num label="at" value={d.at} step={0.5} min={0} onChange={(v) => set((r) => (r.doors[i].at = v))} />
              <select value={d.to} onChange={(e) => set((r) => (r.doors[i].to = e.target.value))} aria-label="Leads to">
                {all
                  .filter((x) => x.room.id !== room.id)
                  .map((x) => (
                    <option key={x.room.id} value={x.room.id}>
                      → {x.room.name}
                    </option>
                  ))}
              </select>
              <button type="button" className="danger" onClick={() => set((r) => r.doors.splice(i, 1))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" disabled={all.length < 2} onClick={() => set((r) => (r.doors ??= []).push({ to: all.find((x) => x.room.id !== room.id)!.room.id, side: "east", at: 1 }))}>
            Add door
          </button>
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="danger"
              onClick={() => {
                p.edit((w) => {
                  for (const f of w.floors) f.rooms = f.rooms.filter((r: Draft) => r.id !== room.id);
                  w.objects = (w.objects ?? []).filter((o: Draft) => o.room !== room.id);
                  for (const { room: r } of rooms(w)) r.doors = (r.doors ?? []).filter((d: Draft) => d.to !== room.id);
                  w.links = (w.links ?? []).filter((l: Draft) => l.from !== room.id && l.to !== room.id);
                });
                p.setRoomId("");
              }}
            >
              Delete room (and what is in it)
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function FloorsTab(p: EditorProps) {
  const all = rooms(p.draft);
  const zones = Object.entries(p.draft.zones ?? {}) as Array<[string, string[]]>;
  return (
    <section>
      <h4>Floors</h4>
      {(p.draft.floors ?? []).map((f: Draft, i: number) => (
        <div key={f.id} className="form-row">
          <input value={f.name} maxLength={60} onChange={(e) => p.edit((w) => (w.floors[i].name = e.target.value))} aria-label="Floor name" />
          <span className="muted small">{f.rooms.length} rooms</span>
          <button type="button" className="danger" disabled={p.draft.floors.length < 2 || f.rooms.length > 0} title="Only empty floors can be removed" onClick={() => p.edit((w) => w.floors.splice(i, 1))}>
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() =>
          p.edit((w) => {
            const id = freshId(w.floors.map((f: Draft) => f.id), "floor");
            w.floors.push({ id, name: `Floor ${w.floors.length + 1}`, rooms: [{ id: freshId(rooms(w).map((x) => x.room.id), "room"), name: "New room", area: { x: 0, z: 0, w: 8, d: 6 } }] });
          })
        }
      >
        Add floor
      </button>

      <h4>Stairs and elevators</h4>
      {(p.draft.links ?? []).map((l: Draft, i: number) => (
        <div key={i} className="form-row">
          {(["from", "to"] as const).map((k) => (
            <select key={k} value={l[k]} onChange={(e) => p.edit((w) => (w.links[i][k] = e.target.value))} aria-label={k}>
              {all.map((x) => (
                <option key={x.room.id} value={x.room.id}>
                  {x.floor.name} · {x.room.name}
                </option>
              ))}
            </select>
          ))}
          <select value={l.kind ?? "stairs"} onChange={(e) => p.edit((w) => (w.links[i].kind = e.target.value))} aria-label="Kind">
            <option>stairs</option>
            <option>elevator</option>
          </select>
          <button type="button" className="danger" onClick={() => p.edit((w) => w.links.splice(i, 1))}>
            ×
          </button>
        </div>
      ))}
      <button type="button" disabled={all.length < 2} onClick={() => p.edit((w) => (w.links ??= []).push({ from: all[0]!.room.id, to: all.at(-1)!.room.id, kind: "stairs" }))}>
        Add stairs
      </button>

      <h4>Zones</h4>
      <p className="muted small">Named groups of rooms, for where things may walk (a kind's access).</p>
      {zones.map(([id, ids]) => (
        <div key={id} className="editor-card">
          <div className="form-row">
            <code>{id}</code>
            <button type="button" className="danger" onClick={() => p.edit((w) => delete w.zones[id])}>
              ×
            </button>
          </div>
          <div className="checks small">
            {all.map((x) => (
              <label key={x.room.id}>
                <input
                  type="checkbox"
                  checked={ids.includes(x.room.id)}
                  onChange={() => p.edit((w) => (w.zones[id] = ids.includes(x.room.id) ? ids.filter((r) => r !== x.room.id) : [...ids, x.room.id]))}
                />{" "}
                {x.room.name}
              </label>
            ))}
          </div>
        </div>
      ))}
      <button type="button" onClick={() => p.edit((w) => ((w.zones ??= {})[freshId(Object.keys(w.zones), "zone")] = [all[0]!.room.id]))}>
        Add zone
      </button>
    </section>
  );
}

function KindsTab(p: EditorProps) {
  const kinds = p.draft.kinds ?? {};
  const [open, setOpen] = useState<string>(Object.keys(kinds)[0] ?? "");
  const k: Draft | undefined = kinds[open];
  const set = (fn: (k: Draft) => void) => p.edit((w) => fn(w.kinds[open]));
  const lookType = !k ? "" : "character" in k.look ? "character" : "parts" in k.look ? "parts" : "asset";
  const models = p.assets.filter((a) => a.kind === "model");
  const parts: string[] = k && "parts" in k.look ? k.look.parts.map((x: Draft) => x.part).filter(Boolean) : [];
  const accessKind = !k ? "own-room" : typeof k.access === "string" ? k.access : k.access && "zone" in k.access ? "zone" : k.access ? "rooms" : "own-room";
  const all = rooms(p.draft);
  return (
    <section>
      <div className="form-row">
        <select value={open} onChange={(e) => setOpen(e.target.value)} aria-label="Kind">
          {Object.entries(kinds).map(([id, x]) => (
            <option key={id} value={id}>
              {(x as Draft).name} ({id})
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            const id = freshId(Object.keys(kinds), "kind");
            p.edit((w) => ((w.kinds ??= {})[id] = { name: "New thing", category: "static", look: { parts: [{ shape: "box", size: [1, 1, 1], offset: [0, 0.5, 0], color: "#9aa3ad" }] } }));
            setOpen(id);
          }}
        >
          New kind
        </button>
      </div>
      {k && (
        <div className="editor-card">
          <div className="nums">
            <label className="num wide">
              <span>name</span>
              <input value={k.name} maxLength={60} onChange={(e) => set((x) => (x.name = e.target.value))} />
            </label>
            <label className="num">
              <span>category</span>
              <select value={k.category} onChange={(e) => set((x) => (x.category = e.target.value))}>
                <option value="character">character (person/animal)</option>
                <option value="static">static</option>
                <option value="dynamic">dynamic</option>
              </select>
            </label>
          </div>

          <h4>Look</h4>
          <div className="seg-toggle" role="group" aria-label="Look">
            {(["character", "parts", "asset"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={lookType === t ? "active" : ""}
                onClick={() =>
                  set((x) => {
                    if (t === "character") x.look = { character: "person", color: "#6b7280" };
                    if (t === "parts") x.look = { parts: [{ shape: "box", size: [1, 1, 1], offset: [0, 0.5, 0], color: "#9aa3ad" }] };
                    if (t === "asset") x.look = { asset: models[0]?.id ?? "", scale: 1 };
                  })
                }
              >
                {t === "parts" ? "built from shapes" : t === "asset" ? "uploaded model" : "built-in character"}
              </button>
            ))}
          </div>
          {lookType === "character" && (
            <div className="nums">
              <label className="num">
                <span>character</span>
                <select value={k.look.character} onChange={(e) => set((x) => (x.look.character = e.target.value))}>
                  {CHARACTERS.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label className="num">
                <span>color</span>
                <input type="color" value={k.look.color ?? "#6b7280"} onChange={(e) => set((x) => (x.look.color = e.target.value))} />
              </label>
              <label className="num">
                <span>accent</span>
                <input type="color" value={k.look.accent ?? "#3b2a20"} onChange={(e) => set((x) => (x.look.accent = e.target.value))} />
              </label>
              <Num label="scale" value={k.look.scale ?? 1} min={0.1} max={5} onChange={(v) => set((x) => (x.look.scale = v))} />
            </div>
          )}
          {lookType === "parts" && (
            <>
              {k.look.parts.map((part: Draft, i: number) => (
                <div key={i} className="part-row">
                  <select value={part.shape} onChange={(e) => set((x) => (x.look.parts[i].shape = e.target.value))} aria-label="Shape">
                    {SHAPES.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                  <Vec3 label="size" value={part.size} onChange={(v) => set((x) => (x.look.parts[i].size = v))} />
                  <Vec3 label="offset" value={part.offset} onChange={(v) => set((x) => (x.look.parts[i].offset = v))} />
                  <Vec3 label="rotation" value={part.rotation} onChange={(v) => set((x) => (x.look.parts[i].rotation = v))} />
                  <input type="color" value={part.color ?? "#9aa3ad"} onChange={(e) => set((x) => (x.look.parts[i].color = e.target.value))} aria-label="Color" />
                  <label className="small" title="Glows (and can blink)">
                    <input
                      type="checkbox"
                      checked={!!part.emissive}
                      onChange={(e) => set((x) => (x.look.parts[i].emissive = e.target.checked ? (part.color ?? "#ffffff") : undefined))}
                    />{" "}
                    glow
                  </label>
                  <input value={part.part ?? ""} placeholder="name" className="mono short" onChange={(e) => set((x) => (x.look.parts[i].part = e.target.value || undefined))} aria-label="Part name" />
                  <button type="button" className="danger" disabled={k.look.parts.length < 2} onClick={() => set((x) => x.look.parts.splice(i, 1))}>
                    ×
                  </button>
                </div>
              ))}
              <button type="button" onClick={() => set((x) => x.look.parts.push({ shape: "box", size: [0.5, 0.5, 0.5], offset: [0, 0.25, 0], color: "#9aa3ad" }))}>
                Add shape
              </button>
            </>
          )}
          {lookType === "asset" && (
            <div className="nums">
              <label className="num wide">
                <span>model</span>
                <select value={k.look.asset} onChange={(e) => set((x) => (x.look.asset = e.target.value))}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="upload small">
                <input
                  type="file"
                  accept=".glb"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    void uploadAsset(f)
                      .then(async (a) => {
                        await p.reloadAssets();
                        set((x) => (x.look.asset = a.id));
                      })
                      .catch((err) => p.notify(err.message, "error"));
                  }}
                />
                Upload .glb
              </label>
              <Num label="scale" value={k.look.scale ?? 1} min={0.01} max={100} onChange={(v) => set((x) => (x.look.scale = v))} />
              <Num label="turn°" value={k.look.rotationY ?? 0} step={15} onChange={(v) => set((x) => (x.look.rotationY = v))} />
            </div>
          )}

          <h4>Behaviors</h4>
          {(k.behaviors ?? []).map((b: Draft, i: number) => (
            <div key={i} className="form-row">
              <select value={b.type} onChange={(e) => set((x) => (x.behaviors[i].type = e.target.value))} aria-label="Behavior">
                {BEHAVIORS.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
              <select value={b.part ?? ""} onChange={(e) => set((x) => (x.behaviors[i].part = e.target.value || undefined))} aria-label="Part">
                <option value="">whole object</option>
                {parts.map((n) => (
                  <option key={n}>{n}</option>
                ))}
              </select>
              <Num label="speed" value={b.speed ?? 1} min={0} max={20} onChange={(v) => set((x) => (x.behaviors[i].speed = v))} />
              <Num label="amount" value={b.amount ?? 1} min={0} max={20} onChange={(v) => set((x) => (x.behaviors[i].amount = v))} />
              <button type="button" className="danger" onClick={() => set((x) => x.behaviors.splice(i, 1))}>
                ×
              </button>
            </div>
          ))}
          <button type="button" onClick={() => set((x) => (x.behaviors ??= []).push({ type: "bob" }))}>
            Add behavior
          </button>

          <h4>May walk in</h4>
          <div className="form-row">
            <select
              value={accessKind}
              onChange={(e) =>
                set((x) => {
                  const v = e.target.value;
                  x.access = v === "zone" ? { zone: Object.keys(p.draft.zones ?? {})[0] ?? "" } : v === "rooms" ? { rooms: [all[0]?.room.id] } : v;
                })
              }
              aria-label="Access"
            >
              <option value="own-room">its own room</option>
              <option value="own-department">its department's rooms</option>
              <option value="all">everywhere</option>
              <option value="rooms">these rooms…</option>
              <option value="zone">a zone…</option>
            </select>
            {accessKind === "zone" && (
              <select value={k.access.zone} onChange={(e) => set((x) => (x.access = { zone: e.target.value }))} aria-label="Zone">
                {Object.keys(p.draft.zones ?? {}).map((z) => (
                  <option key={z}>{z}</option>
                ))}
              </select>
            )}
          </div>
          {accessKind === "rooms" && (
            <div className="checks small">
              {all.map((x) => (
                <label key={x.room.id}>
                  <input
                    type="checkbox"
                    checked={k.access.rooms.includes(x.room.id)}
                    onChange={() =>
                      set((kk) => {
                        const list: string[] = kk.access.rooms;
                        kk.access.rooms = list.includes(x.room.id) ? list.filter((r) => r !== x.room.id) : [...list, x.room.id];
                      })
                    }
                  />{" "}
                  {x.room.name}
                </label>
              ))}
            </div>
          )}
          <p className="muted small">Only what the office shows; things move only with a roam behavior.</p>

          <div className="btn-row">
            <button
              type="button"
              className="danger"
              onClick={() => {
                p.edit((w) => {
                  delete w.kinds[open];
                  w.objects = (w.objects ?? []).filter((o: Draft) => o.kind !== open);
                  if (w.avatars?.default === open) delete w.avatars.default;
                  for (const [role, id] of Object.entries(w.avatars?.byJobRole ?? {})) if (id === open) delete w.avatars.byJobRole[role];
                });
                setOpen(Object.keys(kinds).find((x) => x !== open) ?? "");
              }}
            >
              Delete kind (and its objects)
            </button>
          </div>
        </div>
      )}

      <h4>How agents look</h4>
      <p className="muted small">A character kind per job title; others use the default, or a person in their department's color.</p>
      {["(default)", ...p.jobRoles].map((role) => {
        const current = role === "(default)" ? p.draft.avatars?.default : p.draft.avatars?.byJobRole?.[role];
        return (
          <div key={role} className="form-row">
            <span className="small" style={{ minWidth: 110 }}>
              {role}
            </span>
            <select
              value={current ?? ""}
              onChange={(e) =>
                p.edit((w) => {
                  w.avatars ??= {};
                  w.avatars.byJobRole ??= {};
                  if (role === "(default)") w.avatars.default = e.target.value || undefined;
                  else if (e.target.value) w.avatars.byJobRole[role] = e.target.value;
                  else delete w.avatars.byJobRole[role];
                })
              }
              aria-label={`Look of ${role}`}
            >
              <option value="">{role === "(default)" ? "a person in the department's color" : "the default"}</option>
              {Object.entries(kinds)
                .filter(([, x]) => (x as Draft).category === "character")
                .map(([id, x]) => (
                  <option key={id} value={id}>
                    {(x as Draft).name}
                  </option>
                ))}
            </select>
          </div>
        );
      })}
      {Object.keys(kinds).some((id) => !ID.test(id)) && <p className="error small">Kind ids must be lowercase letters, digits and dashes.</p>}
    </section>
  );
}

/** Validate a draft world the way the server will; the parsed world when it is good. */
export function validate(draft: Draft, departments: string[]): { world: World | null; errors: string[] } {
  const r = worldSchema.safeParse(draft);
  if (!r.success) return { world: null, errors: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const errors: string[] = [];
  checkWorld(r.data, new Set(departments), (m) => errors.push(m.replace(/^world: /, "")));
  return { world: errors.length ? null : r.data, errors };
}

/** The editor panel, with the asset library loaded only while it is open. */
export function EditorHost(p: Omit<EditorProps, "assets" | "reloadAssets">) {
  const { assets, reload } = useAssets();
  return <WorldEditor {...p} assets={assets} reloadAssets={reload} />;
}
