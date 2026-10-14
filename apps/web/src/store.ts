import { useCallback, useEffect, useRef, useState } from "react";
import { HttpError, api, streamEvents } from "./api.ts";
import type { Agent, AgentEvent, Snapshot, Task } from "./types.ts";

export type ConnStatus = "connecting" | "live" | "reconnecting" | "unauthorized";

export const STRUCTURAL = /^(agent\.|task\.|run\.|grant\.|user\.|runtime\.generation|runtime\.desired|artifact\.)/;
const HEARTBEAT_STALE_MS = 45_000;

/**
 * Single source of truth for the office and every panel: snapshot + cursor,
 * then live deltas. On any disconnect we re-take the snapshot and resume from
 * its cursor, so characters never stay frozen in an old state.
 */
export function useOffice(signedIn: boolean, onEvent?: (e: AgentEvent) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [feed, setFeed] = useState<AgentEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const skew = useRef(0);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const [{ agents }, { tasks }] = await Promise.all([
      api<{ agents: Agent[] }>("GET", "/api/agents"),
      api<{ tasks: Task[] }>("GET", "/api/tasks"),
    ]);
    setSnapshot((s) => (s ? { ...s, agents, tasks } : s));
  }, []);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      void refresh().catch(() => {});
    }, 250);
  }, [refresh]);

  useEffect(() => {
    if (!signedIn) return;
    const abort = new AbortController();
    let stopped = false;
    (async () => {
      let first = true;
      while (!stopped) {
        try {
          setStatus(first ? "connecting" : "reconnecting");
          const snap = await api<Snapshot>("GET", "/api/office/snapshot");
          skew.current = Date.now() - new Date(snap.serverTime).getTime();
          setSnapshot(snap);
          setStatus("live");
          first = false;
          await streamEvents(
            snap.cursor,
            (e: AgentEvent) => {
              setSnapshot((s) => (s ? applyEvent(s, e) : s));
              setFeed((f) => [e, ...f].slice(0, 80));
              if (STRUCTURAL.test(e.type)) scheduleRefresh();
              onEventRef.current?.(e);
            },
            abort.signal,
          );
        } catch (err) {
          if (err instanceof HttpError && err.status === 401) {
            setStatus("unauthorized");
            return;
          }
        }
        if (stopped) return;
        setStatus("reconnecting");
        await new Promise((r) => setTimeout(r, 2000));
      }
    })();
    const tick = setInterval(() => setNow(Date.now()), 2000);
    // Heartbeats without a state change emit no event; re-read liveness periodically.
    const poll = setInterval(() => void refresh().catch(() => {}), 15000);
    return () => {
      stopped = true;
      abort.abort();
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [signedIn, scheduleRefresh, refresh]);

  /** Work state the character should show right now (stale heartbeats read as offline). */
  const effectiveWork = useCallback(
    (a: Agent) => {
      if (a.work.state === "offline" || a.work.state === "error") return a.work.state;
      const hb = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() + skew.current : 0;
      if (!a.runtime?.ready || now - hb > HEARTBEAT_STALE_MS) return "offline";
      return a.work.state;
    },
    [now],
  );

  return { snapshot, status, feed, refresh, effectiveWork, now };
}

function applyEvent(s: Snapshot, e: AgentEvent): Snapshot {
  const patch = (fn: (a: Agent) => Agent) => ({
    ...s,
    cursor: e.seq,
    agents: s.agents.map((a) => (a.id === e.agentId ? fn(a) : a)),
  });
  switch (e.type) {
    case "work.state":
      return patch((a) => ({
        ...a,
        lastHeartbeatAt: e.at,
        work: { state: e.payload.state, reported: e.payload.state, detail: e.payload.detail ?? null, updatedAt: e.at },
      }));
    case "runtime.state":
      return patch((a) => ({
        ...a,
        runtime: a.runtime
          ? { ...a.runtime, state: e.payload.state, detail: e.payload.detail, ready: !!e.payload.ready, generation: e.payload.generation, workloadRef: e.payload.workloadRef, observedAt: e.at }
          : a.runtime,
      }));
    case "agent.intake":
      return patch((a) => ({ ...a, acceptingWork: !!e.payload.acceptingWork }));
    default:
      return { ...s, cursor: e.seq };
  }
}
