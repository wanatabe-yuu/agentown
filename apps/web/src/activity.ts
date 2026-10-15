import { t } from "./i18n.ts";
import type { AgentEvent } from "./types.ts";

/** One line of plain text from a Markdown report. */
export const plain = (md: string) => md.replace(/```[\s\S]*?```/g, " ").replace(/[*_`#>|]+/g, "").replace(/\s+/g, " ").trim().slice(0, 160);

/** What the Activity list says about an event; events not listed here are too low-level to show. */
export const EVENT_TEXT: Record<string, (e: AgentEvent, name: (id: string | null) => string) => string> = {
  "agent.spawned": (e, n) => t("{name} joined as {role}", { name: n(e.agentId), role: e.payload.jobRole }),
  "task.created": (e, n) => t("{from} → {to}: {title}", { from: e.payload.createdBy?.startsWith("agent:") ? n(e.payload.createdBy.slice(6)) : t("A person"), to: n(e.agentId), title: e.payload.title }),
  "task.status": (e) => t("{title}: {from} → {to}", { title: e.payload.title, from: t(String(e.payload.from).replace("_", " ")), to: t(String(e.payload.to).replace("_", " ")) }),
  "run.started": (e, n) => t("{name} started {title}", { name: n(e.agentId), title: e.payload.title }),
  "agent.said": (e, n) => `${n(e.agentId)}: ${String(e.payload.text ?? "")}`,
  "task.question": (e, n) => t("{name} asks: {question}", { name: n(e.agentId), question: e.payload.question }),
  "run.finished": (e, n) => t("{name} finished: {outcome}", { name: n(e.agentId), outcome: t(e.payload.outcome) }) + (e.payload.summary ? ` — ${plain(String(e.payload.summary))}` : ""),
  "run.lost": (e, n) => t("{name} lost a run: {why}", { name: n(e.agentId), why: e.payload.why }),
  "artifact.created": (e, n) => t("{name} delivered {file}", { name: n(e.agentId), file: e.payload.name }),
  "agent.configured": (e, n) => t("{name} now uses {model}", { name: n(e.agentId), model: e.payload.model ?? t("the default model") }),
  "agent.team": (e, n) => t("{name} moved to team {team}", { name: n(e.agentId), team: e.payload.teamId }),
  "runtime.generation": (e, n) => t("{name} got a fresh runtime: {why}", { name: n(e.agentId), why: String(e.payload.reason ?? "").replace(/^harness image.*/, t("new runtime image")).replace(/^resize /, t("resources") + " ").replace(/^restart requested by (?:human:)?(.*)$/, (_, who: string) => t("restart requested by {who}", { who: who === "owner" ? t("the owner") : who })).replace(" - ", " → ") }),
  "agent.retired": (e, n) => t("{name} retired", { name: n(e.agentId) }),
  "grant.created": (e, n) => t("{name} received {action}", { name: n(e.agentId), action: e.payload.action }),
  "grant.revoked": (e, n) => t("{name} lost {action}", { name: n(e.agentId), action: e.payload.action }),
  "credential.created": (e) => t("API key \"{name}\" added", { name: e.payload.name }),
  "credential.revoked": () => t("An API key was revoked"),
  "user.created": (e) => t("{name} was invited", { name: e.payload.displayName }),
};

