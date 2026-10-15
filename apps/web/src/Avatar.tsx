import type { World } from "@agentown/core/world";
import { createContext, useContext, useEffect, useState } from "react";
import { orgPath } from "./api.ts";
import { t } from "./i18n.ts";
import type { Agent, Department } from "./types.ts";

/**
 * Who said or did something, as a small round picture: an uploaded image, else
 * a portrait of their 3D model, else their initial. The owner is "you"; the
 * system chat is a gear.
 */
export type Who = { type: "you" } | { type: "system" } | { type: "agent" | "object"; id: string };

interface Roster {
  world: World | null;
  agents: Agent[];
  departments: Department[];
  /** The owner's own name, for their initial. */
  me?: string;
}
const RosterContext = createContext<Roster>({ world: null, agents: [], departments: [] });
export const AvatarRoster = RosterContext.Provider;

const imageUrl = (id: string) => orgPath(`/api/assets/${encodeURIComponent(id)}`);

/** Name, picture and color of someone in this organization. */
function useWho(who: Who): { name: string; image: string | null; color: string; initial: string } {
  const r = useContext(RosterContext);
  const [picture, setPicture] = useState<string | null>(null);
  const agent = who.type === "agent" ? r.agents.find((a) => a.id === who.id) : undefined;
  const object = who.type === "object" ? r.world?.objects.find((o) => o.id === who.id) : undefined;
  const kind = object ? r.world?.kinds[object.kind] : undefined;
  const color = agent ? (r.departments.find((d) => d.id === agent.departmentId)?.color ?? "#8899aa") : "var(--accent)";
  const uploaded = agent ? r.world?.avatars.byAgent?.[agent.id]?.image : object?.image;
  const lookKey = agent ? JSON.stringify([agent.jobRole, color, r.world?.avatars.byAgent?.[agent.id], r.world?.avatars.byJobRole[agent.jobRole], r.world?.avatars.default]) : kind ? JSON.stringify(kind.look) : "";
  useEffect(() => {
    let live = true;
    setPicture(null);
    if (uploaded || (!agent && !kind)) return;
    void import("./office3d/portrait.ts").then((m) => (agent ? m.agentPortrait(agent, r.world, color) : m.lookPortrait(kind!.look))).then((url) => live && url && setPicture(url));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [who.type, (who as { id?: string }).id, uploaded, lookKey]);
  const name =
    who.type === "you" ? t("You") : who.type === "system" ? t("System") : (agent?.displayName ?? object?.label ?? kind?.name ?? (who as { id: string }).id);
  const initial = (who.type === "you" ? (r.me ?? name) : name).trim().slice(0, 1).toUpperCase();
  return { name, image: uploaded ? imageUrl(uploaded) : picture, color, initial };
}

const Gear = () => (
  <svg viewBox="0 0 24 24" aria-hidden width="62%" height="62%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </svg>
);

export function WhoName({ who }: { who: Who }) {
  const w = useWho(who);
  return <>{who.type === "system" ? t("System chat") : w.name}</>;
}

export function Avatar({ who, size = 28, className = "" }: { who: Who; size?: number; className?: string }) {
  const w = useWho(who);
  return (
    <span className={`who-avatar who-${who.type} ${className}`} style={{ width: size, height: size, "--who": w.color } as React.CSSProperties} title={w.name} aria-hidden>
      {who.type === "system" ? <Gear /> : w.image ? <img src={w.image} alt="" draggable={false} /> : <span style={{ fontSize: size * 0.42 }}>{w.initial}</span>}
    </span>
  );
}
