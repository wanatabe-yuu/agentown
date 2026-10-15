import { type OrgConfig, type TeamConfig, teamsOf } from "@agentown/core";
import { badRequest } from "../util.ts";

/** Rules: the organization's structure — departments, teams, projects, job templates — as its owner wrote it. */
export class Rules {
  constructor(readonly config: OrgConfig) {}

  teams(): TeamConfig[] {
    return teamsOf(this.config);
  }

  team(id: string): TeamConfig | undefined {
    return this.teams().find((t) => t.id === id);
  }

  /** True when the owner listed this team (not a department's implicit default team). */
  explicitTeam(id: string): boolean {
    return (this.config.teams ?? []).some((t) => t.id === id);
  }

  /** The team an agent works in: its own (if still in its department), or its department's default team. */
  resolveTeam(departmentId: string, teamId: string | null): TeamConfig {
    const teams = this.teams();
    const t = (teamId && teams.find((x) => x.id === teamId && x.department === departmentId)) || teams.find((x) => x.id === departmentId);
    if (!t) throw badRequest(`department ${departmentId} has no team`);
    return t;
  }

  teamOf(a: { department_id: string; team_id: string | null }): TeamConfig {
    return this.resolveTeam(a.department_id, a.team_id);
  }

  hasDepartment(id: string): boolean {
    return this.config.departments.some((d) => d.id === id);
  }
}
