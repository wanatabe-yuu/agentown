import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Queryable } from "./db.ts";
import { badRequest, notFound } from "./util.ts";

/**
 * Self-patching: this install changes its own code. An agent with code.propose
 * on the repository "self" downloads the source it runs (code.read), edits it
 * and proposes a unified diff; the owner reviews and approves; the approved
 * patch is queued here. The host's builder (deploy/agentown-selfpatch, a root
 * systemd unit) builds it as the unprivileged agentown user, installs it,
 * health-checks the server and rolls back if it does not come up, then leaves
 * a result file that is written back onto the proposal.
 *
 *   <dir>/enabled            the host installed the builder
 *   <dir>/queue/<id>.patch   approved, waiting (+ <id>.json: org, proposal, title)
 *   <dir>/results/<id>.json  { status: "installed" | "failed", log }
 */

export const SELF_REPO = "self";
const dir = () => process.env.AGENTOWN_SELFPATCH_DIR ?? "/var/lib/agentown/selfpatch";
/** The release's own source, next to server/ (…/current/source.tar.gz). */
export const sourceTarball = () => process.env.AGENTOWN_SOURCE_TARBALL ?? resolve(dirname(process.argv[1] ?? "."), "..", "source.tar.gz");

export const selfPatchEnabled = () => existsSync(join(dir(), "enabled"));

const DIFF = /^(diff --git |--- |\+\+\+ |@@ )/m;

/** Queue an approved patch for the host's builder; `key` is the proposal's (unique). */
export function queuePatch(orgId: string, key: string, input: { title: string; summary: string; diff: string }) {
  if (!selfPatchEnabled()) throw badRequest("self-patching is not set up on this host (the installer's AGENTOWN_SELF_PATCH=1 adds the builder)");
  if (!DIFF.test(input.diff)) throw badRequest("diff must be a unified diff (git diff)");
  const id = key.replace(/[^\w-]+/g, "-").slice(0, 80);
  const queue = join(dir(), "queue");
  mkdirSync(queue, { recursive: true });
  // Write the description first and the patch last: the builder starts on the .patch.
  writeFileSync(join(queue, `${id}.json`), JSON.stringify({ orgId, title: input.title, summary: input.summary, queuedAt: new Date().toISOString() }));
  writeFileSync(join(queue, `${id}.patch.tmp`), input.diff.endsWith("\n") ? input.diff : `${input.diff}\n`);
  renameSync(join(queue, `${id}.patch.tmp`), join(queue, `${id}.patch`));
  return { queued: id, note: "the host builds, installs and health-checks it; the result is added to this proposal" };
}

/** Builder results back onto their proposals (the gateway's idempotency key is proposal-<id>). */
export async function collectResults(db: Queryable) {
  const results = join(dir(), "results");
  if (!existsSync(results)) return;
  for (const file of readdirSync(results).filter((f) => f.endsWith(".json"))) {
    let r: { status?: string; log?: string };
    try {
      r = JSON.parse(readFileSync(join(results, file), "utf8"));
    } catch {
      continue; // still being written
    }
    const id = file.slice(0, -5).replace(/^proposal-/, "");
    await db.query(
      `UPDATE proposals SET receipt = COALESCE(receipt, '{}'::jsonb) || $2::jsonb,
         status = CASE WHEN $3::boolean THEN 'failed' ELSE status END, error = CASE WHEN $3::boolean THEN $4 ELSE error END, updated_at = now()
       WHERE id = $1`,
      [id, JSON.stringify({ build: r.status ?? "unknown" }), r.status !== "installed", String(r.log ?? "").slice(-2000)],
    );
    renameSync(join(results, file), join(results, `${file}.done`));
  }
}

/** The raw diff of a code proposal, for review before approving. */
export async function proposalDiff(db: Queryable, orgId: string, id: string): Promise<string> {
  const { rows } = await db.query<{ payload: { capability?: string; args?: { title?: string; summary?: string; diff?: string } } }>(
    "SELECT payload FROM proposals WHERE id=$1 AND org_id=$2",
    [id, orgId],
  );
  const args = rows[0]?.payload.capability === "propose_patch" ? rows[0].payload.args : undefined;
  if (!args?.diff) throw notFound("code proposal");
  return `# ${args.title ?? ""}\n# ${(args.summary ?? "").replace(/\n/g, "\n# ")}\n\n${args.diff}`;
}
