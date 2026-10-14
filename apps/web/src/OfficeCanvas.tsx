import { useEffect, useMemo, useRef, useState } from "react";
import { type Flight, computeLayout, drawOffice, hitTest } from "./office.ts";
import type { Agent, Snapshot, WorkState } from "./types.ts";

interface Props {
  snapshot: Snapshot;
  workOf: (a: Agent) => WorkState;
  needsOwner: Set<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
  flights: Flight[];
  dark: boolean;
}

export function OfficeCanvas(props: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const layout = useMemo(() => computeLayout(props.snapshot), [props.snapshot]);
  const view = useRef({ x: 0, y: 0, scale: 1, fitted: false });
  const [hover, setHover] = useState<string | null>(null);
  const latest = useRef({ props, layout, hover });
  latest.current = { props, layout, hover };

  const fit = () => {
    const el = wrap.current;
    const l = latest.current.layout;
    if (!el || !l.rooms.length) return;
    const pad = 24;
    const s = Math.max(0.35, Math.min((el.clientWidth - pad * 2) / l.width, (el.clientHeight - pad * 2) / l.height, 1.3));
    view.current = { scale: s, x: (el.clientWidth - l.width * s) / 2, y: pad, fitted: true };
  };

  // Fit the office into the viewport once we know its size.
  useEffect(() => {
    if (!view.current.fitted) fit();
  }, [layout]);

  // Render loop.
  useEffect(() => {
    let raf = 0;
    const frame = (t: number) => {
      const c = canvas.current;
      const el = wrap.current;
      if (c && el) {
        const dpr = window.devicePixelRatio || 1;
        const w = el.clientWidth;
        const h = el.clientHeight;
        if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
          c.width = Math.round(w * dpr);
          c.height = Math.round(h * dpr);
          c.style.width = `${w}px`;
          c.style.height = `${h}px`;
        }
        const ctx = c.getContext("2d")!;
        const { props: p, layout: l, hover: hv } = latest.current;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const v = view.current;
        ctx.setTransform(dpr * v.scale, 0, 0, dpr * v.scale, dpr * v.x, dpr * v.y);
        drawOffice(ctx, {
          snapshot: p.snapshot,
          layout: l,
          workOf: p.workOf,
          needsOwner: p.needsOwner,
          selected: p.selected,
          hover: hv,
          flights: p.flights,
          t: performance.now(),
          dark: p.dark,
        });
      }
      void t;
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pan / zoom / select.
  useEffect(() => {
    const c = canvas.current!;
    let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
    const toWorld = (cx: number, cy: number) => {
      const v = view.current;
      return { x: (cx - v.x) / v.scale, y: (cy - v.y) / v.scale };
    };
    const local = (e: PointerEvent | WheelEvent) => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const down = (e: PointerEvent) => {
      c.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, moved: false };
    };
    const move = (e: PointerEvent) => {
      if (drag) {
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        view.current.x = drag.vx + dx;
        view.current.y = drag.vy + dy;
      } else {
        const p = local(e);
        const w = toWorld(p.x, p.y);
        const id = hitTest(latest.current.layout, w.x, w.y);
        setHover(id);
        c.style.cursor = id ? "pointer" : "grab";
      }
    };
    const up = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const p = local(e);
        const w = toWorld(p.x, p.y);
        latest.current.props.onSelect(hitTest(latest.current.layout, w.x, w.y));
      }
      drag = null;
    };
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      const v = view.current;
      const next = Math.min(2.5, Math.max(0.3, v.scale * Math.exp(-e.deltaY * 0.0015)));
      v.x = p.x - ((p.x - v.x) / v.scale) * next;
      v.y = p.y - ((p.y - v.y) / v.scale) * next;
      v.scale = next;
    };
    c.addEventListener("pointerdown", down);
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", up);
    c.addEventListener("wheel", wheel, { passive: false });
    return () => {
      c.removeEventListener("pointerdown", down);
      c.removeEventListener("pointermove", move);
      c.removeEventListener("pointerup", up);
      c.removeEventListener("wheel", wheel);
    };
  }, []);

  return (
    <div ref={wrap} className="office-canvas">
      <canvas ref={canvas} aria-label="Office floor plan; select an agent to open its panel" />
      <div className="zoom-controls">
        <button type="button" onClick={() => (view.current.scale = Math.min(2.5, view.current.scale * 1.2))} aria-label="Zoom in">+</button>
        <button type="button" onClick={() => (view.current.scale = Math.max(0.3, view.current.scale / 1.2))} aria-label="Zoom out">−</button>
        <button type="button" onClick={fit} aria-label="Fit office to screen">⤢</button>
      </div>
    </div>
  );
}
