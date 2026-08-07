import type { RuntimePolicy } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { validateBatchInput } from "../validation/batch-input.js";
import { ExecExecutor } from "./exec-executor.js";
import type { ProcessRunner } from "./process-runner.js";
import type { BatchExecResult, CommandResult, ValidatedExecInput } from "./types.js";

/** Backward-compatible adapter. New clients should call ExecExecutor through `exec`. */
export class BatchExecutor {
  readonly #execExecutor: ExecExecutor;
  readonly #ownsExecutor: boolean;

  public constructor(
    private readonly policy: RuntimePolicy,
    logger: Logger,
    processRunner?: ProcessRunner,
    execExecutor?: ExecExecutor,
  ) {
    this.#execExecutor =
      execExecutor ?? new ExecExecutor(policy, logger, processRunner);
    this.#ownsExecutor = execExecutor === undefined;
  }

  public async execute(
    untrustedInput: unknown,
    signal?: AbortSignal,
  ): Promise<BatchExecResult> {
    const legacy = validateBatchInput(untrustedInput, this.policy);
    const input: ValidatedExecInput = {
      steps: legacy.commands.map((command) => ({ ...command, dependsOn: [] })),
      concurrency: legacy.concurrency,
      failureMode: legacy.failureMode,
      output: {
        mode: "debug",
        maxTotalBytes: legacy.maxOutputBytes * legacy.commands.length * 2,
        maxStreamBytes: legacy.maxOutputBytes,
        capture: "head",
        stripAnsi: false,
      },
    };
    const result = await this.#execExecutor.executeValidated(input, signal);
    const results: CommandResult[] = result.results.map((command) => ({
      id: command.id,
      status: command.status,
      exit_code: command.exit_code,
      signal: command.signal,
      stdout: command.stdout,
      stderr: command.stderr,
      stdout_bytes: command.stdout_bytes,
      stderr_bytes: command.stderr_bytes,
      stdout_truncated: command.stdout_truncated,
      stderr_truncated: command.stderr_truncated,
      duration_ms: command.duration_ms,
      error: command.error,
      rejection_reason: command.rejection_reason,
      global_queue_wait_ms: command.global_queue_wait_ms,
      ...(command.stdout_resource === undefined
        ? {}
        : { stdout_resource: command.stdout_resource }),
      ...(command.stderr_resource === undefined
        ? {}
        : { stderr_resource: command.stderr_resource }),
    }));
    const summary = {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      failed: result.summary.failed,
      timed_out: result.summary.timed_out,
      cancelled: result.summary.cancelled,
      skipped: result.summary.skipped,
      rejected: result.summary.rejected,
      spawn_errors: result.summary.spawn_errors,
      wall_time_ms: result.summary.wall_time_ms,
      effective_concurrency: result.summary.effective_concurrency,
    };
    return { request_id: result.request_id, results, summary };
  }

  public async shutdown(): Promise<void> {
    if (this.#ownsExecutor) {
      await this.#execExecutor.shutdown();
    }
  }
}
