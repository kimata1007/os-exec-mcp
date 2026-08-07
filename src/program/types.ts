import type { CommandResult } from "../executor/types.js";

export type ProgramCommandOptions = {
  cwd?: string;
  timeout_ms?: number;
};

export type ExecProgramInput = {
  source: string;
  allowed_executables: string[];
  cwd?: string;
  limits?: {
    max_exec_calls?: number;
    max_concurrency?: number;
    timeout_ms?: number;
    memory_bytes?: number;
    max_return_bytes?: number;
  };
};

export type ValidatedExecProgramInput = {
  source: string;
  allowedExecutables: string[];
  cwd?: string;
  limits: {
    maxExecCalls: number;
    maxConcurrency: number;
    timeoutMs: number;
    memoryBytes: number;
    maxReturnBytes: number;
  };
};

export type ProgramRuntimeInput = {
  source: string;
  timeoutMs: number;
  memoryBytes: number;
};

export type ProgramHostExecutor = (
  argv: string[],
  options: ProgramCommandOptions,
) => Promise<CommandResult>;

export type ProgramRuntime = {
  run(
    input: ProgramRuntimeInput,
    execute: ProgramHostExecutor,
    signal?: AbortSignal,
  ): Promise<unknown>;
};

export type ExecProgramResult = {
  request_id: string;
  value: unknown;
  summary: {
    exec_calls: number;
    wall_time_ms: number;
    global_peak_concurrency: number;
  };
};

export type WorkerInput = ProgramRuntimeInput;

export type WorkerToHostMessage =
  | {
      type: "exec_request";
      id: number;
      argv: unknown;
      options: unknown;
    }
  | { type: "result"; value: unknown }
  | { type: "error"; code: string; message: string };

export type HostToWorkerMessage =
  | { type: "exec_response"; id: number; result: CommandResult }
  | { type: "exec_error"; id: number; message: string };
