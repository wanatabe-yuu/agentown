/**
 * Runtime entry point. A team runtime (AGENTOWN_TEAM_ID) starts the supervisor,
 * which runs each member as its own process of this same file (AGENTOWN_AGENT_ID).
 */
if (process.env.AGENTOWN_TEAM_ID && !process.env.AGENTOWN_AGENT_ID) await import("./supervisor.ts");
else await import("./member.ts");
export {};
