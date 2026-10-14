import type { AgentNode } from "./types.ts";

/** Read-only view of the reporting tree. Built fresh per request from the DB. */
export class OrgGraph {
  readonly agents: Map<string, AgentNode>;
  private readonly children = new Map<string, string[]>();

  constructor(agents: Iterable<AgentNode>) {
    this.agents = new Map();
    for (const a of agents) this.agents.set(a.id, a);
    for (const a of this.agents.values()) {
      if (a.reportsToAgentId) {
        const list = this.children.get(a.reportsToAgentId) ?? [];
        list.push(a.id);
        this.children.set(a.reportsToAgentId, list);
      }
    }
  }

  get(id: string): AgentNode | undefined {
    return this.agents.get(id);
  }

  directReports(id: string): string[] {
    return this.children.get(id) ?? [];
  }

  descendants(id: string): Set<string> {
    const out = new Set<string>();
    const stack = [...this.directReports(id)];
    while (stack.length) {
      const next = stack.pop()!;
      if (out.has(next)) continue;
      out.add(next);
      stack.push(...this.directReports(next));
    }
    return out;
  }

  isDescendant(ancestorId: string, id: string): boolean {
    let cur = this.agents.get(id)?.reportsToAgentId ?? null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      if (cur === ancestorId) return true;
      seen.add(cur);
      cur = this.agents.get(cur)?.reportsToAgentId ?? null;
    }
    return false;
  }

  /** Would setting `agentId.reportsTo = managerId` create a cycle? */
  wouldCreateCycle(agentId: string, managerId: string | null): boolean {
    if (!managerId) return false;
    if (managerId === agentId) return true;
    return this.isDescendant(agentId, managerId);
  }
}
