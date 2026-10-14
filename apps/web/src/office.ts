import type { Agent, Department, Snapshot, WorkState } from "./types.ts";

/**
 * Top-down office renderer (Canvas 2D). Purely a view: positions come from
 * department + seat, appearance comes from reported state. Nothing here
 * changes permissions or reporting lines.
 */

export const DESK_COLS = 3;
const CELL_W = 120;
const CELL_H = 112;
const ROOM_PAD = 20;
const ROOM_HEADER = 30;
const ROOM_GAP = 36;
const ROOM_COLS = 2;

export interface Room {
  dept: Department;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  rooms: Room[];
  seats: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

export interface Flight {
  from: string;
  to: string;
  start: number;
  label: string;
}

export function computeLayout(s: Snapshot): Layout {
  const active = s.agents.filter((a) => a.lifecycleState !== "retired");
  const rooms: Room[] = [];
  const seats = new Map<string, { x: number; y: number }>();
  const sizes = s.departments.map((d) => {
    const here = active.filter((a) => a.departmentId === d.id);
    const cap = Math.max(DESK_COLS, ...here.map((a) => a.seat + 1));
    const rows = Math.ceil(cap / DESK_COLS);
    return { d, w: ROOM_PAD * 2 + DESK_COLS * CELL_W, h: ROOM_HEADER + ROOM_PAD * 2 + rows * CELL_H };
  });
  let y = 0;
  for (let i = 0; i < sizes.length; i += ROOM_COLS) {
    const row = sizes.slice(i, i + ROOM_COLS);
    const rowH = Math.max(...row.map((r) => r.h));
    let x = 0;
    for (const r of row) {
      rooms.push({ dept: r.d, x, y, w: r.w, h: rowH });
      x += r.w + ROOM_GAP;
    }
    y += rowH + ROOM_GAP;
  }
  for (const a of active) {
    const room = rooms.find((r) => r.dept.id === a.departmentId);
    if (!room) continue;
    const col = a.seat % DESK_COLS;
    const row = Math.floor(a.seat / DESK_COLS);
    seats.set(a.id, {
      x: room.x + ROOM_PAD + col * CELL_W + CELL_W / 2,
      y: room.y + ROOM_HEADER + ROOM_PAD + row * CELL_H + 30,
    });
  }
  const width = Math.max(...rooms.map((r) => r.x + r.w), 400);
  const height = Math.max(...rooms.map((r) => r.y + r.h), 300);
  return { rooms, seats, width, height };
}

export function hitTest(layout: Layout, wx: number, wy: number): string | null {
  for (const [id, p] of layout.seats) {
    if (wx > p.x - 44 && wx < p.x + 44 && wy > p.y - 34 && wy < p.y + 70) return id;
  }
  return null;
}

const SCREEN: Record<string, string> = {
  running: "#4ade80",
  pending: "#facc15",
  restarting: "#fb923c",
  failed: "#ef4444",
  stopped: "#475569",
  none: "#334155",
  unknown: "#a78bfa",
};

function shade(hex: string, amt: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  return `rgb(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)})`;
}

/** Blend a hex colour toward white (amt>0) or toward the dark stage (amt<0). */
function tint(hex: string, amt: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const target = amt >= 0 ? [255, 255, 255] : [11, 18, 32];
  const k = Math.abs(amt);
  const ch = (v: number, i: number) => Math.round(v + (target[i]! - v) * k);
  return `rgb(${ch((n >> 16) & 255, 0)},${ch((n >> 8) & 255, 1)},${ch(n & 255, 2)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

export interface DrawInput {
  snapshot: Snapshot;
  layout: Layout;
  workOf: (a: Agent) => WorkState;
  needsOwner: Set<string>;
  selected: string | null;
  hover: string | null;
  flights: Flight[];
  t: number;
  dark: boolean;
}

export function drawOffice(ctx: CanvasRenderingContext2D, d: DrawInput) {
  const { layout, snapshot, t } = d;
  // rooms
  for (const room of layout.rooms) {
    const c = room.dept.color;
    ctx.fillStyle = d.dark ? tint(c, -0.78) : tint(c, 0.82);
    roundRect(ctx, room.x, room.y, room.w, room.h, 10);
    ctx.fill();
    // floor tiles
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = d.dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.05)";
    ctx.lineWidth = 1;
    for (let x = room.x; x < room.x + room.w; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, room.y);
      ctx.lineTo(x, room.y + room.h);
      ctx.stroke();
    }
    for (let y = room.y; y < room.y + room.h; y += 24) {
      ctx.beginPath();
      ctx.moveTo(room.x, y);
      ctx.lineTo(room.x + room.w, y);
      ctx.stroke();
    }
    ctx.restore();
    ctx.lineWidth = 4;
    ctx.strokeStyle = d.dark ? shade(c, -0.2) : shade(c, -0.15);
    roundRect(ctx, room.x, room.y, room.w, room.h, 10);
    ctx.stroke();
    ctx.fillStyle = d.dark ? shade(c, -0.2) : shade(c, -0.15);
    roundRect(ctx, room.x, room.y, room.w, ROOM_HEADER, 10);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "600 14px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(room.dept.name, room.x + 12, room.y + ROOM_HEADER / 2);
    // empty desks for free seats
    const used = new Set(snapshot.agents.filter((a) => a.departmentId === room.dept.id && a.lifecycleState !== "retired").map((a) => a.seat));
    const rows = Math.floor((room.h - ROOM_HEADER - ROOM_PAD * 2) / CELL_H);
    for (let s = 0; s < rows * DESK_COLS; s++) {
      if (used.has(s)) continue;
      const x = room.x + ROOM_PAD + (s % DESK_COLS) * CELL_W + CELL_W / 2;
      const y = room.y + ROOM_HEADER + ROOM_PAD + Math.floor(s / DESK_COLS) * CELL_H + 30;
      drawDesk(ctx, x, y, "none", false, t, d.dark, 0.35);
    }
  }

  // agents
  for (const a of snapshot.agents) {
    const p = layout.seats.get(a.id);
    if (!p) continue;
    const work = d.workOf(a);
    const offline = work === "offline";
    drawDesk(ctx, p.x, p.y, a.runtime?.state ?? "none", work === "executing", t, d.dark, 1);
    const dept = snapshot.departments.find((x) => x.id === a.departmentId);
    drawPerson(ctx, p.x, p.y + 30, dept?.color ?? "#888", work, t, offline, a.id);

    if (d.selected === a.id || d.hover === a.id) {
      ctx.lineWidth = d.selected === a.id ? 3 : 2;
      ctx.strokeStyle = d.selected === a.id ? "#38bdf8" : "rgba(56,189,248,0.5)";
      roundRect(ctx, p.x - 46, p.y - 36, 92, 108, 10);
      ctx.stroke();
    }
    // name + role
    ctx.textAlign = "center";
    ctx.fillStyle = d.dark ? "#e2e8f0" : "#0f172a";
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.fillText(a.displayName, p.x, p.y + 60);
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillStyle = d.dark ? "#94a3b8" : "#475569";
    ctx.fillText(a.jobRole.toUpperCase(), p.x, p.y + 72);
    ctx.textAlign = "start";

    if (!a.acceptingWork && !offline) badge(ctx, p.x + 30, p.y + 6, "#64748b", "II");
    if (d.needsOwner.has(a.id)) bubble(ctx, p.x + 22, p.y - 6, "#facc15", "?", "#422006");
    else if (work === "blocked") bubble(ctx, p.x + 22, p.y - 6, "#ef4444", "!", "#fff");
    else if (work === "error") bubble(ctx, p.x + 22, p.y - 6, "#ef4444", "×", "#fff");
    else if (work === "waiting") bubble(ctx, p.x + 22, p.y - 6, "#e2e8f0", "⌛", "#0f172a");
    else if (work === "thinking") {
      const dots = ".".repeat(1 + (Math.floor(t / 400) % 3));
      bubble(ctx, p.x + 22, p.y - 6, "#fff", dots, "#0f172a");
    }
  }

  // task hand-offs: a sheet of paper flying from creator to assignee
  for (const f of d.flights) {
    const a = layout.seats.get(f.from);
    const b = layout.seats.get(f.to);
    if (!a || !b) continue;
    const k = Math.min(1, (t - f.start) / 1400);
    const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    const x = a.x + (b.x - a.x) * e;
    const y = a.y + (b.y - a.y) * e - Math.sin(Math.PI * k) * 60;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.sin(t / 120) * 0.2);
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1;
    ctx.fillRect(-8, -10, 16, 20);
    ctx.strokeRect(-8, -10, 16, 20);
    ctx.fillStyle = "#94a3b8";
    for (let i = 0; i < 4; i++) ctx.fillRect(-5, -6 + i * 4, 10, 1.5);
    ctx.restore();
  }
}

function drawDesk(ctx: CanvasRenderingContext2D, x: number, y: number, runtime: string, typing: boolean, t: number, dark: boolean, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  // desk
  ctx.fillStyle = dark ? "#5b4636" : "#b08968";
  roundRect(ctx, x - 40, y - 8, 80, 30, 4);
  ctx.fill();
  ctx.fillStyle = dark ? "#4a382b" : "#9c7656";
  ctx.fillRect(x - 40, y + 18, 80, 4);
  // monitor = the agent's runtime
  ctx.fillStyle = "#1e293b";
  roundRect(ctx, x - 18, y - 30, 36, 24, 3);
  ctx.fill();
  const screen = SCREEN[runtime] ?? SCREEN.unknown!;
  ctx.fillStyle = screen;
  ctx.globalAlpha = alpha * (runtime === "running" ? 0.9 : 0.75);
  ctx.fillRect(x - 15, y - 27, 30, 18);
  if (typing) {
    ctx.fillStyle = "#052e16";
    for (let i = 0; i < 3; i++) {
      const w = 6 + ((Math.floor(t / 150) + i * 7) % 16);
      ctx.fillRect(x - 12, y - 24 + i * 5, w, 2);
    }
  }
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "#334155";
  ctx.fillRect(x - 3, y - 6, 6, 4);
  // keyboard
  ctx.fillStyle = dark ? "#cbd5e1" : "#e2e8f0";
  ctx.fillRect(x - 14, y + 4, 28, 6);
  ctx.restore();
}

function drawPerson(ctx: CanvasRenderingContext2D, x: number, y: number, color: string, work: WorkState, t: number, offline: boolean, id: string) {
  ctx.save();
  // chair
  ctx.fillStyle = "#475569";
  roundRect(ctx, x - 16, y - 4, 32, 22, 6);
  ctx.fill();
  if (offline) {
    ctx.restore();
    return; // empty chair: runtime not up or not heartbeating
  }
  const phase = [...id].reduce((s, c) => s + c.charCodeAt(0), 0);
  const bob = work === "executing" ? Math.sin(t / 90 + phase) * 1.5 : work === "thinking" ? Math.sin(t / 500 + phase) * 1 : 0;
  // body
  ctx.fillStyle = color;
  roundRect(ctx, x - 14, y - 10 + bob, 28, 20, 8);
  ctx.fill();
  // arms reaching to keyboard when typing
  if (work === "executing") {
    ctx.fillStyle = shade(color, -0.15);
    ctx.fillRect(x - 15, y - 16 + Math.sin(t / 70 + phase) * 2, 6, 10);
    ctx.fillRect(x + 9, y - 16 + Math.cos(t / 70 + phase) * 2, 6, 10);
  }
  // head (seen from above/behind)
  ctx.fillStyle = "#f1c27d";
  ctx.beginPath();
  ctx.arc(x, y - 14 + bob, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = ["#3b2a20", "#111827", "#7c2d12", "#a16207"][phase % 4]!;
  ctx.beginPath();
  ctx.arc(x, y - 16 + bob, 9, Math.PI, Math.PI * 2);
  ctx.fill();
  if (work === "idle") {
    // idle: leaning back, small coffee cup
    ctx.fillStyle = "#fff";
    ctx.fillRect(x + 20, y - 2, 6, 7);
    ctx.fillStyle = "#78350f";
    ctx.fillRect(x + 21, y - 1, 4, 2);
  }
  ctx.restore();
}

function bubble(ctx: CanvasRenderingContext2D, x: number, y: number, bg: string, text: string, fg: string) {
  ctx.save();
  ctx.fillStyle = bg;
  ctx.strokeStyle = "rgba(0,0,0,0.25)";
  ctx.lineWidth = 1;
  roundRect(ctx, x - 2, y - 30, 26, 20, 8);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 2, y - 11);
  ctx.lineTo(x - 4, y - 4);
  ctx.lineTo(x + 8, y - 11);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = "700 13px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 11, y - 20);
  ctx.restore();
}

function badge(ctx: CanvasRenderingContext2D, x: number, y: number, bg: string, text: string) {
  ctx.save();
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.font = "700 8px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
  ctx.restore();
}
