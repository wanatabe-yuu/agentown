/**
 * Minimal GitHub REST client for what Agentown needs: inspect a repository,
 * check that its default branch is protected, open a pull request. There is
 * deliberately no merge call anywhere in this codebase.
 */
export interface RepoRef {
  owner: string;
  name: string;
  apiBase: string; // https://api.github.com, or a GitHub Enterprise / test endpoint
}

export interface RepoInfo {
  defaultBranch: string;
  canPush: boolean;
  defaultBranchProtected: boolean | null;
}

export interface CodeHost {
  inspect(repo: RepoRef, token: string): Promise<RepoInfo>;
  openPullRequest(repo: RepoRef, token: string, pr: { title: string; body: string; head: string; base: string }): Promise<{ number: number; url: string }>;
}

async function gh(repo: RepoRef, token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${repo.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "agentown",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${json?.message ?? ""}`.trim());
  return json;
}

export const githubHost: CodeHost = {
  async inspect(repo, token) {
    const r = await gh(repo, token, "GET", `/repos/${repo.owner}/${repo.name}`);
    let isProtected: boolean | null = null;
    try {
      const b = await gh(repo, token, "GET", `/repos/${repo.owner}/${repo.name}/branches/${encodeURIComponent(r.default_branch)}`);
      isProtected = !!b.protected;
    } catch {
      isProtected = null;
    }
    return { defaultBranch: r.default_branch, canPush: !!r.permissions?.push, defaultBranchProtected: isProtected };
  },
  async openPullRequest(repo, token, pr) {
    const r = await gh(repo, token, "POST", `/repos/${repo.owner}/${repo.name}/pulls`, { ...pr, maintainer_can_modify: true });
    return { number: r.number, url: r.html_url };
  },
};
