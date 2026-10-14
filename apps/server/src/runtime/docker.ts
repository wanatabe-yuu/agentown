import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import type { ExecStreams, PodInfo, RuntimeDriver, RuntimeSpec } from "./driver.ts";
import { podName } from "./driver.ts";

/**
 * Docker Engine driver: one container per agent runtime generation, one named
 * volume per agent workspace, one bridge network per department with
 * inter-container communication disabled.
 *
 * This is the single-machine / development runtime. It has no cluster-side
 * admission layer: the guarantee rests on the server being the only holder of
 * the Docker socket and only ever building containers from the runtime catalog.
 * Kubernetes (k3s) adds RBAC + admission policy as a second, independent wall.
 */
export class DockerDriver implements RuntimeDriver {
  readonly kind = "docker";

  constructor(
    private readonly secretDir: string,
    private readonly socketPath = "/var/run/docker.sock",
  ) {
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  }

  private call<T = any>(method: string, path: string, body?: unknown, okStatus: number[] = []): Promise<{ status: number; body: T }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path: `/v1.43${path}`,
          method,
          headers: body !== undefined ? { "content-type": "application/json" } : {},
          timeout: 30_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: any = text;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {}
            const status = res.statusCode ?? 0;
            if (status >= 400 && !okStatus.includes(status)) {
              reject(Object.assign(new Error(`docker ${method} ${path}: ${status} ${json?.message ?? text}`), { status }));
            } else resolve({ status, body: json as T });
          });
        },
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("docker API timeout")));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private networkName(namespace: string) {
    return namespace; // agentown-<department>
  }

  async listPods(namespace: string, agentId: string): Promise<PodInfo[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`agentown.io/agent=${agentId}`, `agentown.io/namespace=${namespace}`] }));
    const { body } = await this.call<any[]>("GET", `/containers/json?all=1&filters=${filters}`);
    const out: PodInfo[] = [];
    for (const c of body) {
      const { body: info } = await this.call<any>("GET", `/containers/${c.Id}/json`);
      const st = info.State ?? {};
      let phase = "Pending";
      let waitingReason: string | null = null;
      if (st.Restarting) {
        phase = "Running";
        waitingReason = "CrashLoopBackOff";
      } else if (st.Running) phase = "Running";
      else if (st.Status === "exited" || st.Status === "dead") phase = st.ExitCode === 0 ? "Succeeded" : "Failed";
      out.push({
        name: (info.Name as string).replace(/^\//, ""),
        generation: Number(info.Config?.Labels?.["agentown.io/generation"] ?? 0),
        phase,
        ready: !!st.Running && !st.Restarting,
        terminating: st.Status === "removing",
        restarts: info.RestartCount ?? 0,
        waitingReason,
        message: st.Error || (st.ExitCode ? `exit code ${st.ExitCode}` : null),
      });
    }
    return out;
  }

  private secretPath(agentId: string) {
    return join(this.secretDir, `${agentId}.token`);
  }

  async ensureIdentity(spec: RuntimeSpec, issueToken: () => Promise<string>): Promise<void> {
    const labels = { "app.kubernetes.io/managed-by": "agentown", "agentown.io/agent": spec.agentId };
    const net = this.networkName(spec.namespace);
    const { status } = await this.call("GET", `/networks/${net}`, undefined, [404]);
    if (status === 404) {
      await this.call(
        "POST",
        "/networks/create",
        {
          Name: net,
          Driver: "bridge",
          CheckDuplicate: true,
          Labels: { "app.kubernetes.io/managed-by": "agentown" },
          // Agents never talk to each other directly, not even within a department.
          Options: { "com.docker.network.bridge.enable_icc": "false" },
        },
        [409],
      );
    }
    await this.call("POST", "/volumes/create", { Name: spec.storageRef, Labels: labels });
    if (!existsSync(this.secretPath(spec.agentId))) {
      const token = await issueToken();
      writeFileSync(this.secretPath(spec.agentId), token, { mode: 0o600 });
      chmodSync(this.secretPath(spec.agentId), 0o600);
    }
  }

  async createPod(spec: RuntimeSpec): Promise<string> {
    const name = podName(spec.agentId, spec.generation);
    const token = readFileSync(this.secretPath(spec.agentId), "utf8").trim();
    const env = [
      `AGENTOWN_API_URL=${spec.apiUrl}`,
      `AGENTOWN_AGENT_ID=${spec.agentId}`,
      `AGENTOWN_GENERATION=${spec.generation}`,
      `AGENTOWN_HARNESS=${spec.preset.harness}`,
      `AGENTOWN_DISPLAY_NAME=${spec.displayName}`,
      `AGENTOWN_JOB_ROLE=${spec.jobRole}`,
      `AGENTOWN_TOKEN=${token}`,
      "HOME=/workspace/home",
    ];
    if (spec.preset.model) env.push(`AGENTOWN_MODEL=${spec.preset.model}`);
    if (spec.preset.providerSecret && process.env.ANTHROPIC_API_KEY) env.push(`ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
    const cpu = parseCpu(spec.preset.resources.cpu);
    const mem = parseMemory(spec.preset.resources.memory);
    const { status } = await this.call(
      "POST",
      `/containers/create?name=${name}`,
      {
        Image: spec.preset.image,
        User: "1000:1000",
        Hostname: spec.agentId,
        Env: env,
        Labels: {
          "app.kubernetes.io/managed-by": "agentown",
          "agentown.io/agent": spec.agentId,
          "agentown.io/generation": String(spec.generation),
          "agentown.io/namespace": spec.namespace,
          "agentown.io/preset": spec.preset.id,
        },
        HostConfig: {
          NetworkMode: this.networkName(spec.namespace),
          Mounts: [{ Type: "volume", Source: spec.storageRef, Target: "/workspace" }],
          Tmpfs: { "/tmp": "rw,nosuid,nodev,size=256m" },
          ReadonlyRootfs: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          Privileged: false,
          Memory: mem,
          NanoCpus: Math.round(cpu * 1e9),
          PidsLimit: 256,
          RestartPolicy: { Name: "on-failure", MaximumRetryCount: 5 },
          ExtraHosts: ["host.docker.internal:host-gateway"],
        },
      },
      [409],
    );
    if (status !== 409) await this.call("POST", `/containers/${name}/start`, undefined, [304]);
    return name;
  }

  async deletePod(_namespace: string, name: string): Promise<void> {
    await this.call("DELETE", `/containers/${name}?force=1`, undefined, [404, 409]);
  }

  async teardown(_namespace: string, agentId: string, purgeWorkspace: boolean): Promise<void> {
    rmSync(this.secretPath(agentId), { force: true });
    if (purgeWorkspace) await this.call("DELETE", `/volumes/agent-${agentId}-workspace`, undefined, [404, 409]);
  }

  async exec(_namespace: string, pod: string, command: string[], streams: ExecStreams) {
    const { body: created } = await this.call<{ Id: string }>("POST", `/containers/${pod}/exec`, {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      User: "1000:1000",
      Cmd: command,
    });
    const execId = created.Id;
    const socket: Duplex = await new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.socketPath,
        path: `/v1.43/exec/${execId}/start`,
        method: "POST",
        headers: { "content-type": "application/json", connection: "Upgrade", upgrade: "tcp" },
      });
      req.on("upgrade", (_res, sock, head) => {
        if (head.length) sock.unshift(head);
        resolve(sock);
      });
      req.on("response", (res) => reject(new Error(`exec start failed: ${res.statusCode}`)));
      req.on("error", reject);
      req.end(JSON.stringify({ Detach: false, Tty: true }));
    });
    const out = streams.stdout as NodeJS.WritableStream & { columns?: number; rows?: number; on: (e: string, f: () => void) => void };
    const resize = () =>
      void this.call("POST", `/exec/${execId}/resize?h=${out.rows ?? 30}&w=${out.columns ?? 100}`, undefined, [404, 409, 500]).catch(() => {});
    out.on("resize", resize);
    resize();
    streams.stdin.pipe(socket);
    socket.on("data", (d: Buffer) => streams.stdout.write(d));
    socket.on("close", async () => {
      const { body } = await this.call<any>("GET", `/exec/${execId}/json`, undefined, [404]).catch(() => ({ body: null }));
      streams.onExit({ status: body?.ExitCode === 0 ? "Success" : "Failure", message: body ? `exit code ${body.ExitCode}` : undefined });
    });
    return { close: () => socket.destroy() };
  }
}

function parseCpu(v: string): number {
  return v.endsWith("m") ? Number(v.slice(0, -1)) / 1000 : Number(v);
}

function parseMemory(v: string): number {
  const m = /^(\d+)(Ki|Mi|Gi)?$/.exec(v);
  if (!m) return 512 * 1024 * 1024;
  const mult = { Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3 }[m[2] as "Ki" | "Mi" | "Gi"] ?? 1;
  return Number(m[1]) * mult;
}
