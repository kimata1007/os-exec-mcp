export type FailureMode = "continue" | "fail_fast";

export type CommandRequest = {
  id: string;
  argv: string[];
  cwd?: string;
  timeout_ms?: number;
  env?: Record<string, string>;
};

export type BatchExecInput = {
  commands: CommandRequest[];
  concurrency?: number;
  failure_mode?: FailureMode;
  max_output_bytes?: number;
};

export type WorkflowCommandRequest = CommandRequest & {
  depends_on?: string[];
};

export type WorkflowExecInput = {
  commands: WorkflowCommandRequest[];
  concurrency?: number;
  failure_mode?: FailureMode;
  max_output_bytes?: number;
};

export type ValidatedCommand = {
  id: string;
  argv: string[];
  cwd?: string;
  timeoutMs: number;
  env: Record<string, string>;
};

export type ValidatedBatchInput = {
  commands: ValidatedCommand[];
  concurrency: number;
  failureMode: FailureMode;
  maxOutputBytes: number;
};

export type ValidatedWorkflowCommand = ValidatedCommand & {
  dependsOn: string[];
};

export type ValidatedWorkflowInput = {
  commands: ValidatedWorkflowCommand[];
  concurrency: number;
  failureMode: FailureMode;
  maxOutputBytes: number;
};

export type CommandStatus =
  | "success"
  | "failed"
  | "timeout"
  | "cancelled"
  | "skipped"
  | "rejected"
  | "spawn_error";

export type CommandResult = {
  id: string;
  status: CommandStatus;
  exit_code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdout_bytes: number;
  stderr_bytes: number;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
  duration_ms: number;
  error: string | null;
  rejection_reason: string | null;
};

export type BatchSummary = {
  total: number;
  succeeded: number;
  failed: number;
  timed_out: number;
  cancelled: number;
  skipped: number;
  rejected: number;
  spawn_errors: number;
  wall_time_ms: number;
  effective_concurrency: number;
};

export type BatchExecResult = {
  request_id: string;
  results: CommandResult[];
  summary: BatchSummary;
};

export type WorkflowCommandResult = CommandResult & {
  depends_on: string[];
  blocked_by: string[];
};

export type WorkflowSummary = BatchSummary & {
  peak_concurrency: number;
};

export type WorkflowExecResult = {
  request_id: string;
  results: WorkflowCommandResult[];
  summary: WorkflowSummary;
};

export type PreparedCommand = {
  id: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  env: NodeJS.ProcessEnv;
  maxOutputBytes: number;
};
