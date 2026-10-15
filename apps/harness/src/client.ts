/**
 * Thin client for the Agentown API, authenticated as *this* agent. Everything an
 * agent can do (spawn, assign, read tasks) goes through here and is authorized
 * server-side against the agent's own grants.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  execution?: { runId: string; generation: string };
}

export class AgentownClient {
  constructor(private readonly opts: ClientOptions) {}

  static fromEnv(): AgentownClient {
    const baseUrl = process.env.AGENTOWN_API_URL;
    const token = process.env.AGENTOWN_TOKEN;
    if (!baseUrl || !token) throw new Error("AGENTOWN_API_URL and AGENTOWN_TOKEN must be set");
    return new AgentownClient({ baseUrl: baseUrl.replace(/\/$/, ""), token, ...(process.env.AGENTOWN_RUN_ID && process.env.AGENTOWN_GENERATION ? { execution: { runId: process.env.AGENTOWN_RUN_ID, generation: process.env.AGENTOWN_GENERATION } } : {}) });
  }

  async request<T = any>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(this.opts.execution ? { "x-agentown-run-id": this.opts.execution.runId, "x-agentown-generation": this.opts.execution.generation } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 204) return null as T;
    if (raw && res.ok) return Buffer.from(await res.arrayBuffer()) as T;
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { message: text };
    }
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  get = <T = any>(path: string) => this.request<T>("GET", path);
  post = <T = any>(path: string, body: unknown = {}) => this.request<T>("POST", path, body);
  put = <T = any>(path: string, body: unknown) => this.request<T>("PUT", path, body);
}
