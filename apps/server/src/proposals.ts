import type { Actor } from "@agentown/core";
import type { Queryable } from "./db.ts";
import { actorRef, conflict, newId, notFound, sanitize } from "./util.ts";

/**
 * Proposal & Approval Engine: one record for everything that is proposed,
 * evaluated and approved — chat actions waiting for the owner, finished work
 * waiting for review, configuration changes and their receipts, calls through
 * the capability gateway. It knows nothing about runtimes: the domain code that
 * owns a change opens and settles its proposal, and registers a handler that
 * carries out a decision taken here.
 */

export const PROPOSAL_KINDS = ["capability_call", "config_change", "task_result", "world_change", "permission_change", "runtime_change", "team_change"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_STATUSES = ["pending", "approved", "rejected", "applying", "applied", "failed", "expired", "withdrawn"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Who may decide: the owner, or (for finished work) whoever may review that task. */
export type ApproverRule = { kind: "owner" } | { kind: "task_reviewer"; createdBy: string };
export interface Evaluation {
  rule: string;
  verdict: "allow" | "require_approval" | "deny";
  reason: string;
}
export interface Decision {
  by: string;
  verdict: "approve" | "reject";
  note?: string;
  at: string;
}

export interface ProposalRow {
  id: string;
  org_id: string;
  kind: ProposalKind;
  title: string;
  proposer: string;
  subject_type: string | null;
  subject_id: string | null;
  payload: Record<string, unknown>;
  source_type: string;
  source_id: string;
  status: ProposalStatus;
  evaluation: Evaluation[];
  approvers: ApproverRule;
  decisions: Decision[];
  receipt: unknown;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OpenProposal {
  orgId: string;
  kind: ProposalKind;
  title: string;
  proposer: string;
  subject?: { type: string; id: string } | null;
  payload?: Record<string, unknown>;
  /** The domain record this proposal mirrors (chat_action, task, gateway…); unique. */
  source: { type: string; id: string };
  status?: ProposalStatus;
  evaluation?: Evaluation[];
  approvers?: ApproverRule;
  receipt?: unknown;
}

/** Open (or re-open) the proposal for a domain record. */
export async function openProposal(q: Queryable, p: OpenProposal): Promise<ProposalRow> {
  const { rows } = await q.query<ProposalRow>(
    `INSERT INTO proposals(id, org_id, kind, title, proposer, subject_type, subject_id, payload, source_type, source_id, status, evaluation, approvers, receipt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (source_type, source_id) DO UPDATE SET status=EXCLUDED.status, payload=EXCLUDED.payload, title=EXCLUDED.title,
       receipt=EXCLUDED.receipt, evaluation=EXCLUDED.evaluation, updated_at=now()
     RETURNING *`,
    [
      newId("p"), p.orgId, p.kind, p.title.slice(0, 300), p.proposer, p.subject?.type ?? null, p.subject?.id ?? null,
      JSON.stringify(sanitize(p.payload ?? {})), p.source.type, p.source.id, p.status ?? "pending",
      JSON.stringify(p.evaluation ?? []), JSON.stringify(p.approvers ?? { kind: "owner" }), p.receipt === undefined ? null : JSON.stringify(sanitize(p.receipt)),
    ],
  );
  return rows[0]!;
}

/** Settle or advance the proposal for a domain record. Unknown sources are ignored (nothing was proposed). */
export async function recordProposal(
  q: Queryable,
  source: { type: string; id: string },
  patch: { status: ProposalStatus; decision?: Omit<Decision, "at">; receipt?: unknown; error?: string | null },
): Promise<void> {
  await q.query(
    `UPDATE proposals SET status=$3,
       decisions = CASE WHEN $4::jsonb IS NULL THEN decisions ELSE decisions || $4::jsonb END,
       receipt = COALESCE($5::jsonb, receipt), error = COALESCE($6, error), updated_at=now()
     WHERE source_type=$1 AND source_id=$2 AND status NOT IN ('applied','failed','rejected','expired','withdrawn')`,
    [
      source.type, source.id, patch.status,
      patch.decision ? JSON.stringify([{ ...patch.decision, at: new Date().toISOString() }]) : null,
      patch.receipt === undefined ? null : JSON.stringify(sanitize(patch.receipt)),
      patch.error ?? null,
    ],
  );
}

/** Carries out a decision for proposals of one source type (the owning domain authorizes it). */
export interface ProposalHandler {
  decide(actor: Actor, p: ProposalRow, verdict: "approve" | "reject", note: string): Promise<unknown>;
}

export class ProposalEngine {
  private readonly handlers = new Map<string, ProposalHandler>();
  constructor(private readonly db: Queryable) {}

  register(sourceType: string, handler: ProposalHandler) {
    this.handlers.set(sourceType, handler);
  }

  async get(orgId: string, id: string): Promise<ProposalRow> {
    const { rows } = await this.db.query<ProposalRow>("SELECT * FROM proposals WHERE id=$1 AND org_id=$2", [id, orgId]);
    if (!rows[0]) throw notFound("proposal");
    return rows[0];
  }

  /** Decide a pending proposal. The owning domain checks who may decide and does the work. */
  async decide(orgId: string, actor: Actor, id: string, verdict: "approve" | "reject", note = "") {
    const p = await this.get(orgId, id);
    if (p.status !== "pending") throw conflict("not_pending", `proposal is ${p.status}`);
    const handler = this.handlers.get(p.source_type);
    if (!handler) throw conflict("no_handler", "this proposal cannot be decided here");
    const result = await handler.decide(actor, p, verdict, note);
    return { proposal: present(await this.get(orgId, id)), result };
  }

  /** What a person may see: everything for the owner; otherwise what they proposed or may decide. */
  async list(orgId: string, actor: Actor, filter: { status?: ProposalStatus; kind?: ProposalKind; limit?: number } = {}) {
    const me = actorRef(actor);
    const owner = actor.kind === "human" && actor.owner;
    const { rows } = await this.db.query<ProposalRow>(
      `SELECT * FROM proposals WHERE org_id=$1
         AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR kind=$3)
         AND ($4 OR proposer=$5 OR approvers->>'createdBy'=$5)
       ORDER BY created_at DESC LIMIT $6`,
      [orgId, filter.status ?? null, filter.kind ?? null, owner, me, Math.min(filter.limit ?? 100, 300)],
    );
    return rows.map((p) => ({ ...present(p), canDecide: p.status === "pending" && canDecide(actor, p) }));
  }
}

/** A first answer for the UI; the handler re-checks with the real permissions. */
export function canDecide(actor: Actor, p: Pick<ProposalRow, "approvers" | "proposer">): boolean {
  if (actor.kind === "human" && actor.owner) return true;
  const me = actorRef(actor);
  return p.approvers.kind === "task_reviewer" && p.approvers.createdBy === me && p.proposer !== me;
}

export function present(p: ProposalRow) {
  return {
    id: p.id,
    kind: p.kind,
    title: p.title,
    proposer: p.proposer,
    subject: p.subject_type ? { type: p.subject_type, id: p.subject_id } : null,
    payload: p.payload,
    source: { type: p.source_type, id: p.source_id },
    status: p.status,
    evaluation: p.evaluation,
    approvers: p.approvers,
    decisions: p.decisions,
    receipt: p.receipt,
    error: p.error,
    createdAt: p.created_at.toISOString(),
    updatedAt: p.updated_at.toISOString(),
  };
}
