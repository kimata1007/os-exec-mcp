import type { RuntimePolicy } from "../config/schema.js";
import type { Logger } from "../observability/logger.js";
import { validateWorkflowInput } from "../validation/workflow-input.js";
import { ExecExecutor } from "./exec-executor.js";
import type { ProcessRunner } from "./process-runner.js";
import type { ValidatedExecInput, WorkflowExecResult } from "./types.js";

/** Backward-compatible adapter. New clients should call ExecExecutor through `exec`. */
export class WorkflowExecutor {
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
  ): Promise<WorkflowExecResult> {
    const legacy = validateWorkflowInput(untrustedInput, this.policy);
    const input: ValidatedExecInput = {
      steps: legacy.commands,
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
    return {
      request_id: result.request_id,
      results: result.results,
      summary: result.summary,
    };
  }

  public async shutdown(): Promise<void> {
    if (this.#ownsExecutor) {
      await this.#execExecutor.shutdown();
    }
  }
}
