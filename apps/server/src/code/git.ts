import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Server-side git plumbing. Agents never run git against the real remote and
 * never see its credentials: the server keeps a bare mirror, hands out file
 * snapshots, builds commits from submitted file changes with plumbing commands
 * (no checkout, no hooks), and pushes only to branches it names itself.
 */

export interface FileEntry {
  path: string;
  mode: "100644" | "100755";
  content: Buffer;
}

export interface FileChange {
  path: string;
  mode?: "100644" | "100755";
  content?: Buffer; // absent = delete
}

const MAX_SNAPSHOT_BYTES = 50 * 1024 * 1024;

function git(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Buffer | string; maxBuffer?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", ...opts.env },
        encoding: "buffer",
        maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0]} failed: ${stderr.toString("utf8").replace(/Authorization: \S+ \S+/g, "Authorization: [redacted]").trim().slice(0, 400)}`));
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin!.end(opts.input);
  });
}

/** Credentials travel in env-injected config, never in argv or the remote URL. */
export function authEnv(token: string | null): NodeJS.ProcessEnv {
  if (!token) return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}` };
}

export function validatePath(p: string): string {
  if (typeof p !== "string" || !p || p.length > 300 || p.includes("\0") || p.includes("\\")) throw new Error(`invalid path: ${p}`);
  const parts = p.split("/");
  if (p.startsWith("/") || parts.some((x) => x === "" || x === "." || x === "..")) throw new Error(`invalid path: ${p}`);
  if (parts[0]!.toLowerCase() === ".git" || parts.some((x) => x.toLowerCase() === ".git")) throw new Error(`refusing to touch .git: ${p}`);
  return p;
}

export class Mirror {
  constructor(
    readonly dir: string,
    readonly url: string,
    readonly defaultBranch: string,
  ) {}

  /** Bring the mirror's copy of the default branch up to date; returns its commit. */
  async sync(token: string | null): Promise<string> {
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
      await git(["init", "--bare", "-q", this.dir]);
    }
    await git(["fetch", "-q", "--no-tags", this.url, `+refs/heads/${this.defaultBranch}:refs/heads/${this.defaultBranch}`], { cwd: this.dir, env: authEnv(token) });
    return (await git(["rev-parse", `refs/heads/${this.defaultBranch}`], { cwd: this.dir })).toString().trim();
  }

  async isAncestorOfDefault(sha: string): Promise<boolean> {
    if (!/^[0-9a-f]{40}$/.test(sha)) return false;
    try {
      await git(["merge-base", "--is-ancestor", sha, `refs/heads/${this.defaultBranch}`], { cwd: this.dir });
      return true;
    } catch {
      return false;
    }
  }

  /** Regular files at `sha` (symlinks and submodules are skipped). */
  async snapshot(sha: string): Promise<FileEntry[]> {
    const listing = (await git(["ls-tree", "-r", "-z", "--long", sha], { cwd: this.dir })).toString("utf8").split("\0").filter(Boolean);
    const entries: Array<{ mode: "100644" | "100755"; blob: string; path: string; size: number }> = [];
    let total = 0;
    for (const line of listing) {
      const tab = line.indexOf("\t");
      const [mode, type, blob, size] = line.slice(0, tab).split(/\s+/) as [string, string, string, string];
      if (type !== "blob" || (mode !== "100644" && mode !== "100755")) continue;
      total += Number(size);
      if (total > MAX_SNAPSHOT_BYTES) throw new Error("repository snapshot exceeds 50 MiB");
      entries.push({ mode, blob, path: line.slice(tab + 1), size: Number(size) });
    }
    if (!entries.length) return [];
    // One cat-file process for every blob.
    const out = await git(["cat-file", "--batch"], { cwd: this.dir, input: entries.map((e) => e.blob).join("\n") + "\n", maxBuffer: MAX_SNAPSHOT_BYTES * 2 });
    const files: FileEntry[] = [];
    let off = 0;
    for (const e of entries) {
      const nl = out.indexOf(0x0a, off);
      off = nl + 1;
      files.push({ path: e.path, mode: e.mode, content: out.subarray(off, off + e.size) });
      off += e.size + 1;
    }
    return files;
  }

  /** Build a commit on top of `base` from file changes, using a throwaway index. */
  async commit(base: string, changes: FileChange[], author: { name: string; email: string }, message: string): Promise<string> {
    const tmp = mkdtempSync(join(tmpdir(), "agentown-index-"));
    const env = {
      GIT_INDEX_FILE: join(tmp, "index"),
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: "Agentown",
      GIT_COMMITTER_EMAIL: "agentown@localhost",
    };
    try {
      await git(["read-tree", base], { cwd: this.dir, env });
      for (const c of changes) {
        const path = validatePath(c.path);
        if (c.content === undefined) {
          await git(["update-index", "--force-remove", "--", path], { cwd: this.dir, env });
        } else {
          const blob = (await git(["hash-object", "-w", "--stdin"], { cwd: this.dir, env, input: c.content })).toString().trim();
          await git(["update-index", "--add", "--cacheinfo", `${c.mode ?? "100644"},${blob},${path}`], { cwd: this.dir, env });
        }
      }
      const tree = (await git(["write-tree"], { cwd: this.dir, env })).toString().trim();
      const baseTree = (await git(["rev-parse", `${base}^{tree}`], { cwd: this.dir })).toString().trim();
      if (tree === baseTree) throw new Error("the proposal changes nothing");
      return (await git(["commit-tree", tree, "-p", base, "-F", "-"], { cwd: this.dir, env, input: message })).toString().trim();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async diffStat(base: string, commit: string): Promise<{ files: string[]; additions: number; deletions: number }> {
    const out = (await git(["diff", "--numstat", "-z", "--no-renames", base, commit], { cwd: this.dir })).toString("utf8");
    const files: string[] = [];
    let additions = 0;
    let deletions = 0;
    for (const rec of out.split("\0").filter(Boolean)) {
      const [a, d, ...rest] = rec.split("\t");
      additions += Number(a) || 0;
      deletions += Number(d) || 0;
      files.push(rest.join("\t"));
    }
    return { files, additions, deletions };
  }

  async push(commit: string, branch: string, token: string | null): Promise<void> {
    if (branch === this.defaultBranch || !branch.startsWith("agentown/")) throw new Error(`refusing to push to ${branch}`);
    await git(["push", "-q", this.url, `${commit}:refs/heads/${branch}`], { cwd: this.dir, env: authEnv(token) });
  }
}
