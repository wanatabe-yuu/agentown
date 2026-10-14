export interface TaskInfo {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  spec: { kind: "playbook"; playbook: string; args?: Record<string, string> } | { kind: "script"; script: string } | { kind: "prompt" };
  inputTaskIds: string[];
  parentTaskId: string | null;
  projectId: string | null;
}

export interface RunContext {
  task: TaskInfo;
  runId: string;
  workdir: string;
  outputDir: string;
  stateFile: string;
  signal: AbortSignal;
  log: (stream: "stdout" | "stderr" | "agent", line: string) => void;
  setState: (state: "thinking" | "executing" | "waiting" | "blocked", detail: string) => void;
  event: (type: string, message: string, data?: Record<string, unknown>) => void;
}

export interface RunResult {
  outcome: "succeeded" | "failed" | "blocked";
  summary: string;
  usage?: Record<string, unknown>;
}

export interface Adapter {
  run(ctx: RunContext): Promise<RunResult>;
}
