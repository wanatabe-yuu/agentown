/**
 * Replace every idle team runtime with a new generation, e.g. after loading a new
 * harness image under the same tag. Teams with a run in progress are skipped
 * (run again later). The controller creates the new pods.
 *
 * Usage: DATABASE_URL=… AGENTOWN_CONFIG=… node server/tools/roll-runtimes.mjs [reason]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EventBus } from "../bus.ts";
import { createPool } from "../db.ts";
import { Instance } from "../instance.ts";
import { listModels } from "../providers.ts";
import { SecretBox } from "../secrets.ts";

const reason = process.argv[2] ?? "runtime image updated";
const env = process.env;
const root = resolve(import.meta.dirname, "../../../..");
const db = createPool(env.DATABASE_URL ?? "postgres://agentown:agentown@127.0.0.1:5432/agentown");
try {
  const config = readFileSync(env.AGENTOWN_CONFIG ?? resolve(root, "config/agentown.yaml"), "utf8");
  const secrets = SecretBox.fromEnvOrFile(env.AGENTOWN_SECRET_KEY, resolve(env.AGENTOWN_STATE_DIR ?? resolve(root, ".agentown"), "secret-key"));
  const instance = new Instance(db, config, new EventBus(), secrets, listModels, env.AGENTOWN_TEMPLATES ?? resolve(root, "config/templates"));
  for (const orgId of await instance.activeOrgIds()) {
    const service = await instance.org(orgId);
    for (const plan of await service.teamPlans()) {
      if (!plan.wanted) continue;
      if (await service.teamHasRunningRun(plan.team.id)) {
        console.log(`${orgId}/${plan.team.id}: busy, skipped`);
        continue;
      }
      console.log(`${orgId}/${plan.team.id}: generation ${await service.bumpTeamGeneration(plan.team.id, reason)}`);
    }
  }
} finally {
  await db.end();
}
