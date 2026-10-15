import { type Actor, authorize } from "@agentown/core";
import type { AgentRow, Service } from "./service.ts";
import { canDecide } from "./proposals.ts";
import { badRequest, deny, notFound, redactLine } from "./util.ts";

/**
 * Conversations beyond a person's private chats:
 *  - a team channel, where the team's members and the people overseeing them talk;
 *  - "other": everything else agents say or do — their own reasoning, tool calls,
 *    proposals waiting for approval, and notable events.
 */

export type FeedKind = "self" | "tool" | "proposal" | "event";
export const FEED_KINDS: FeedKind[] = ["self", "tool", "proposal", "event"];

export interface FeedItem {
  id: string;
  at: string;
  kind: FeedKind;
  agentId: string | null;
  teamId: string | null;
  title: string;
  text: string;
  status?: string;
  taskId?: string | null;
  proposalId?: string;
  canDecide?: boolean;
  /** For events: the raw event, so clients can phrase it in their language. */
  event?: { seq: number; at: string; agentId: string | null; taskId: string | null; runId: null; type: string; payload: Record<string, unknown> };
}

const EVENT_TYPES = ["task.created", "task.assigned", "task.status", "run.started", "run.finished", "run.lost", "agent.spawned", "agent.retired", "agent.team", "agent.resources", "runtime.generation", "artifact.created"];

async function teamMembers(svc: Service, teamId: string): Promise<AgentRow[]> {
  const { rows } = await svc.db.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1 AND lifecycle_state <> 'retired' ORDER BY created_at", [svc.orgId]);
  return rows.filter((a) => svc.kernel.rules.teamOf(a).id === teamId);
}

/** Who may read/post in a team's channel: its members, the owner, and anyone who can see one of its members. */
async function requireTeamAccess(svc: Service, actor: Actor, teamId: string) {
  if (!svc.kernel.rules.team(teamId)) throw notFound("team");
  const members = await teamMembers(svc, teamId);
  if (actor.kind === "agent" && members.some((m) => m.id === actor.id)) return members;
  if (actor.kind === "human" && actor.owner) return members;
  const policy = await svc.kernel.permissions.load();
  if (members.some((m) => authorize(actor, "org.view", { agentId: m.id }, policy).allowed)) return members;
  throw deny("not part of this team");
}

export async function listTeamMessages(svc: Service, actor: Actor, teamId: string, after = 0) {
  const members = await requireTeamAccess(svc, actor, teamId);
  const ids = members.map((m) => m.id);
  const names = await nameMap(svc);
  const { rows: msgs } = await svc.db.query(
    "SELECT id, at, author_kind, author_id, text FROM team_messages WHERE org_id=$1 AND team_id=$2 AND id > $3 ORDER BY id DESC LIMIT 200",
    [svc.orgId, teamId, after],
  );
  // The team's work shows up in its channel as it happens.
  const { rows: events } = await svc.db.query(
    `SELECT seq, at, agent_id, task_id, type, payload FROM agent_events
      WHERE org_id=$1 AND agent_id = ANY($2) AND type IN ('run.started','run.finished','run.lost','agent.team')
      ORDER BY seq DESC LIMIT 100`,
    [svc.orgId, ids],
  );
  const messages = [
    ...msgs.map((m) => ({
      id: `m${m.id}`,
      seq: Number(m.id),
      at: m.at.toISOString(),
      author: { kind: m.author_kind as "human" | "agent", id: m.author_id as string, name: names.get(`${m.author_kind}:${m.author_id}`) ?? m.author_id },
      text: m.text as string,
      system: false,
    })),
    ...events.map((e) => ({
      id: `e${e.seq}`,
      seq: 0,
      at: e.at.toISOString(),
      author: { kind: "agent" as const, id: e.agent_id as string, name: names.get(`agent:${e.agent_id}`) ?? e.agent_id },
      text: describeEvent(e.type, e.payload),
      system: true,
      // Clients phrase it in their own language.
      event: { seq: Number(e.seq), at: e.at.toISOString(), agentId: e.agent_id, taskId: e.task_id, runId: null, type: e.type, payload: e.payload },
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return { teamId, memberIds: ids, messages };
}

export async function postTeamMessage(svc: Service, actor: Actor, teamId: string, text: string) {
  await requireTeamAccess(svc, actor, teamId);
  const clean = redactLine(text.trim()).slice(0, 4000);
  if (!clean) throw badRequest("empty message");
  const { rows } = await svc.db.query(
    "INSERT INTO team_messages(org_id, team_id, author_kind, author_id, text) VALUES ($1,$2,$3,$4,$5) RETURNING id, at",
    [svc.orgId, teamId, actor.kind, actor.id, clean],
  );
  await svc.db.query("INSERT INTO agent_events(org_id, agent_id, type, payload) VALUES ($1,$2,'team.message',$3)", [
    svc.orgId,
    actor.kind === "agent" ? actor.id : null,
    JSON.stringify({ teamId, messageId: Number(rows[0].id), author: `${actor.kind}:${actor.id}` }),
  ]);
  return { id: `m${rows[0].id}`, at: rows[0].at.toISOString() };
}

/** Everything else: reasoning, tool calls, proposals and events, newest first, limited to what the caller may see. */
export async function feed(svc: Service, actor: Actor, opts: { kind?: FeedKind; teamId?: string; agentId?: string; limit?: number }) {
  const policy = await svc.kernel.permissions.load();
  const { rows: agents } = await svc.db.query<AgentRow>("SELECT * FROM agents WHERE org_id=$1", [svc.orgId]);
  const teamOf = new Map(agents.map((a) => [a.id, svc.kernel.rules.teamOf(a).id]));
  const visible = agents.filter((a) => authorize(actor, "org.view", { agentId: a.id }, policy).allowed);
  const logsOk = new Set(visible.filter((a) => authorize(actor, "runtime.logs", { agentId: a.id }, policy).allowed).map((a) => a.id));
  const inScope = (id: string | null) => !!id && (!opts.agentId || id === opts.agentId) && (!opts.teamId || teamOf.get(id) === opts.teamId);
  const viewIds = visible.map((a) => a.id).filter(inScope);
  const logIds = viewIds.filter((id) => logsOk.has(id));
  const limit = Math.min(opts.limit ?? 100, 300);
  const want = (k: FeedKind) => !opts.kind || opts.kind === k;
  const items: FeedItem[] = [];

  if ((want("self") || want("tool")) && logIds.length) {
    const { rows } = await svc.db.query(
      `SELECT l.seq, l.at, l.agent_id, l.line, r.task_id FROM agent_logs l LEFT JOIN task_runs r ON r.id=l.run_id
        WHERE l.agent_id = ANY($1) AND l.stream='agent'
          ${opts.kind === "tool" ? "AND l.line LIKE '$ %'" : opts.kind === "self" ? "AND l.line NOT LIKE '$ %'" : ""}
        ORDER BY l.seq DESC LIMIT $2`,
      [logIds, limit],
    );
    for (const r of rows) {
      const tool = (r.line as string).startsWith("$ ");
      items.push({
        id: `l${r.seq}`, at: r.at.toISOString(), kind: tool ? "tool" : "self", agentId: r.agent_id, teamId: teamOf.get(r.agent_id) ?? null,
        title: tool ? "bash" : "thinking", text: tool ? (r.line as string).slice(2) : r.line, taskId: r.task_id,
      });
    }
  }

  if (want("tool") && actor.kind === "human") {
    // Actions taken in this person's own chats (chats are private to their owner).
    const { rows } = await svc.db.query(
      `SELECT a.id, a.name, a.args, a.status, a.created_at, c.subject_type, c.subject_id FROM owner_chat_actions a
         JOIN owner_chat_runs r ON r.id=a.run_id JOIN owner_chats c ON c.id=r.chat_id
        WHERE c.org_id=$1 AND c.user_id=$2 ORDER BY a.created_at DESC LIMIT $3`,
      [svc.orgId, actor.id, limit],
    );
    for (const r of rows) {
      const agentId = r.subject_type === "agent" ? r.subject_id : null;
      if ((opts.agentId || opts.teamId) && !inScope(agentId)) continue;
      items.push({
        id: `c${r.id}`, at: r.created_at.toISOString(), kind: "tool", agentId, teamId: agentId ? teamOf.get(agentId) ?? null : null,
        title: r.name, text: summarizeArgs(r.args), status: r.status,
      });
    }
  }

  if (want("proposal")) {
    // Everything proposed, from the Proposal Engine: what the caller proposed, may decide, or concerns agents they can see.
    const owner = actor.kind === "human" && actor.owner;
    const me = `${actor.kind}:${actor.id}`;
    const { rows } = await svc.db.query(
      `SELECT * FROM proposals WHERE org_id=$1 ORDER BY (status='pending') DESC, created_at DESC LIMIT $2`,
      [svc.orgId, limit * 3],
    );
    for (const p of rows) {
      const agentId = p.subject_type === "agent" ? p.subject_id : p.proposer.startsWith("agent:") ? p.proposer.slice(6) : null;
      const visible = owner || p.proposer === me || p.approvers?.createdBy === me || (agentId && viewIds.includes(agentId));
      if (!visible) continue;
      if ((opts.agentId || opts.teamId) && !inScope(agentId)) continue;
      items.push({
        id: `p${p.id}`, at: p.created_at.toISOString(), kind: "proposal", agentId, teamId: agentId ? teamOf.get(agentId) ?? null : null,
        title: p.title, text: describeProposal(p), status: p.status,
        taskId: p.kind === "task_result" ? (p.payload?.taskId ?? null) : null,
        proposalId: p.id, canDecide: p.status === "pending" && canDecide(actor, p),
      });
    }
  }

  if (want("event") && viewIds.length) {
    const { rows } = await svc.db.query(
      `SELECT seq, at, agent_id, task_id, type, payload FROM agent_events
        WHERE org_id=$1 AND agent_id = ANY($2) AND (type = ANY($3) OR type LIKE 'harness.%') ORDER BY seq DESC LIMIT $4`,
      [svc.orgId, viewIds, EVENT_TYPES, limit],
    );
    for (const e of rows) {
      items.push({
        id: `e${e.seq}`, at: e.at.toISOString(), kind: "event", agentId: e.agent_id, teamId: teamOf.get(e.agent_id) ?? null,
        title: e.type, text: describeEvent(e.type, e.payload), taskId: e.task_id,
        event: { seq: Number(e.seq), at: e.at.toISOString(), agentId: e.agent_id, taskId: e.task_id, runId: null, type: e.type, payload: e.payload },
      });
    }
  }

  items.sort((a, b) => b.at.localeCompare(a.at));
  return { items: items.slice(0, limit) };
}

async function nameMap(svc: Service) {
  const names = new Map<string, string>();
  const { rows: a } = await svc.db.query("SELECT id, display_name FROM agents WHERE org_id=$1", [svc.orgId]);
  for (const r of a) names.set(`agent:${r.id}`, r.display_name);
  const { rows: u } = await svc.db.query("SELECT u.id, u.display_name FROM org_members m JOIN users u ON u.id=m.user_id WHERE m.org_id=$1", [svc.orgId]);
  for (const r of u) names.set(`human:${r.id}`, r.display_name);
  return names;
}

function describeProposal(p: { kind: string; payload: any; receipt: any; error: string | null; proposer: string }): string {
  const who = p.proposer.replace(/^(agent|human):/, "");
  if (p.kind === "task_result") return `${who}: ${String(p.payload?.summary ?? "").slice(0, 400)}`;
  if (p.kind === "config_change") return `changed: ${(p.receipt?.changedFields ?? []).join(", ") || "—"}`;
  if (p.kind === "capability_call") return `${who} → ${p.payload?.tool ?? p.payload?.capability} ${summarizeArgs(p.payload?.args)}${p.error ? ` · ${p.error.slice(0, 200)}` : ""}`;
  return summarizeArgs(p.payload);
}

function summarizeArgs(args: unknown): string {
  const s = JSON.stringify(args ?? {});
  return redactLine(s.length > 300 ? `${s.slice(0, 300)}…` : s);
}

function describeEvent(type: string, p: Record<string, any> = {}): string {
  switch (type) {
    case "run.started": return `started "${p.title ?? "a task"}" (attempt ${p.attempt ?? 1})`;
    case "run.finished": return `finished a run: ${p.outcome ?? ""}${p.summary ? ` — ${String(p.summary).slice(0, 200)}` : ""}`;
    case "run.lost": return `lost a run: ${p.why ?? ""}`;
    case "task.created": return `task created: ${p.title ?? ""}`;
    case "task.assigned": return `task assigned`;
    case "task.status": return `task ${p.from ?? ""} → ${p.to ?? p.status ?? ""}${p.reason ? ` (${p.reason})` : ""}`;
    case "agent.spawned": return `joined as ${p.jobRole ?? "agent"}`;
    case "agent.retired": return "retired";
    case "agent.team": return `moved to team ${p.teamId}`;
    case "agent.resources": return `declared resources ${p.cpu ?? ""} ${p.memory ?? ""}`.trim();
    case "runtime.generation": return `runtime replaced: ${p.reason ?? ""}`;
    case "artifact.created": return `produced ${p.name ?? "a file"}`;
    default: return p.message ? String(p.message) : type;
  }
}
