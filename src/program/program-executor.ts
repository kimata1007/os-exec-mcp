import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type { RuntimePolicy } from "../config/schema.js";
import {
  ExecutionLimiter,
  ExecutionLimiterError,
} from "../executor/execution-limiter.js";
import { ProcessRunner } from "../executor/process-runner.js";
import type { CommandResult, ValidatedCommand } from "../executor/types.js";
import type { Logger } from "../observability/logger.js";
import { CommandPolicyEvaluator } from "../policy/command-policy.js";
import { PolicyRejectionError } from "../policy/errors.js";
import {
  programArgvSchema,
  programCommandOptionsSchema,
  validateExecProgramInput,
} from "../validation/program-input.js";
import { ProgramExecutionError } from "./errors.js";
import { QuickJsProgramRuntime } from "./quickjs-runtime.js";
import type {
  ExecProgramResult,
  ProgramCommandOptions,
  ProgramRuntime,
} from "./types.js";

function syntheticResult(
  id: string,
  status: "cancelled" | "rejected",
  error: string,
  rejectionReason: string | null,
): CommandResult {
  return {
    id,
    status,
    exit_code: null,
    signal: null,
    stdout: "",
    stderr: "",
    stdout_bytes: 0,
    stderr_bytes: 0,
    stdout_truncated: false,
    stderr_truncated: false,
    duration_ms: 0,
    error,
    rejection_reason: rejectionReason,
    global_queue_wait_ms: 0,
  };
}

export class ProgramExecutor {
  readonly #policyEvaluator: CommandPolicyEvaluator;

  public constructor(
    private readonly policy: RuntimePolicy,
    private readonly logger: Logger,
    private readonly processRunner: ProcessRunner,
    private readonly runtime: ProgramRuntime = new QuickJsProgramRuntime(),
  ) {
    this.#policyEvaluator = new CommandPolicyEvaluator(policy);
  }

  public async execute(
    untrustedInput: unknown,
    signal?: AbortSignal,
  ): Promise<ExecProgramResult> {
    const input = validateExecProgramInput(untrustedInput, this.policy);
    const requestId = randomUUID();
    const startedAt = performance.now();
    const localLimiter = new ExecutionLimiter(input.limits.maxConcurrency);
    const programController = new AbortController();
    const commandSignal =
      signal === undefined
        ? programController.signal
        : AbortSignal.any([signal, programController.signal]);
    const allowed = new Set(input.allowedExecutables);
    let execCalls = 0;

    this.logger.info("exec_program_started", {
      request_id: requestId,
      allowed_executable_count: allowed.size,
      max_exec_calls: input.limits.maxExecCalls,
      max_concurrency: input.limits.maxConcurrency,
      timeout_ms: input.limits.timeoutMs,
      memory_bytes: input.limits.memoryBytes,
    });

    const executeCommand = async (
      untrustedArgv: string[],
      untrustedOptions: ProgramCommandOptions,
    ): Promise<CommandResult> => {
      execCalls += 1;
      if (execCalls > input.limits.maxExecCalls) {
        throw new Error(
          `Program exceeded max_exec_calls of ${input.limits.maxExecCalls}`,
        );
      }
      const argv = programArgvSchema.parse(untrustedArgv);
      const options = programCommandOptionsSchema.parse(untrustedOptions);
      const id = `program-${execCalls}`;
      const executable = argv[0];
      if (executable === undefined || !allowed.has(executable)) {
        return syntheticResult(
          id,
          "rejected",
          "Executable is not in exec_program.allowed_executables",
          "program_executable_not_allowed",
        );
      }
      const timeoutMs = options.timeout_ms ?? this.policy.defaultTimeoutMs;
      if (timeoutMs > this.policy.maxTimeoutMs) {
        return syntheticResult(
          id,
          "rejected",
          `timeout_ms exceeds server limit ${this.policy.maxTimeoutMs}`,
          "timeout_exceeds_policy",
        );
      }
      const command: ValidatedCommand = {
        id,
        argv,
        ...((options.cwd ?? input.cwd) === undefined
          ? {}
          : { cwd: options.cwd ?? input.cwd }),
        timeoutMs,
        env: {},
      };

      let permit;
      try {
        permit = await localLimiter.acquire(commandSignal);
      } catch (error) {
        if (error instanceof ExecutionLimiterError) {
          return syntheticResult(id, "cancelled", error.message, null);
        }
        throw error;
      }
      try {
        const prepared = await this.#policyEvaluator.prepare(
          command,
          this.policy.defaultMaxOutputBytes,
          "head_tail",
          true,
        );
        return await this.processRunner.run(prepared, commandSignal);
      } catch (error) {
        if (error instanceof PolicyRejectionError) {
          return syntheticResult(id, "rejected", error.message, error.code);
        }
        throw error;
      } finally {
        permit.release();
      }
    };

    try {
      const value = await this.runtime.run(
        {
          source: input.source,
          timeoutMs: input.limits.timeoutMs,
          memoryBytes: input.limits.memoryBytes,
        },
        executeCommand,
        signal,
      );
      let serializedValue: unknown;
      try {
        serializedValue = JSON.stringify(value);
      } catch {
        throw new ProgramExecutionError(
          "execution_failed",
          "finish(value) must be JSON serializable",
        );
      }
      if (typeof serializedValue !== "string") {
        throw new ProgramExecutionError(
          "execution_failed",
          "finish(value) must be JSON serializable",
        );
      }
      const serialized = serializedValue;
      const returnBytes = Buffer.byteLength(serialized, "utf8");
      if (returnBytes > input.limits.maxReturnBytes) {
        throw new ProgramExecutionError(
          "result_too_large",
          `Program result is ${returnBytes} bytes; limit is ${input.limits.maxReturnBytes}`,
        );
      }
      const jsonValue = JSON.parse(serialized) as unknown;
      const wallTimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      this.logger.info("exec_program_finished", {
        request_id: requestId,
        exec_calls: execCalls,
        wall_time_ms: wallTimeMs,
      });
      return {
        request_id: requestId,
        value: jsonValue,
        summary: {
          exec_calls: execCalls,
          wall_time_ms: wallTimeMs,
          global_peak_concurrency: this.processRunner.globalPeakConcurrency,
        },
      };
    } finally {
      programController.abort(new Error("Program execution ended"));
      localLimiter.shutdown();
    }
  }
}
