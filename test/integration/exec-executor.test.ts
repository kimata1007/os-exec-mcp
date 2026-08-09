import { afterEach, describe, expect, it } from "vitest";

import { ExecExecutor } from "../../src/executor/exec-executor.js";
import { ExecutionLimiter } from "../../src/executor/execution-limiter.js";
import { ProcessRunner } from "../../src/executor/process-runner.js";
import { createLogger } from "../../src/observability/logger.js";
import { fixturePath } from "../helpers/runner.js";
import { testPolicy } from "../helpers/policy.js";

const executors: ExecExecutor[] = [];
const runners: ProcessRunner[] = [];

afterEach(async () => {
  await Promise.all(
    executors.splice(0).map(async (executor) => await executor.shutdown()),
  );
  await Promise.all(runners.splice(0).map(async (runner) => await runner.shutdown()));
});

function createExecutor(): ExecExecutor {
  const executor = new ExecExecutor(testPolicy(process.cwd()), createLogger("silent"));
  executors.push(executor);
  return executor;
}

describe("ExecExecutor", () => {
  it("runs independent and dependent steps through the same scheduler", async () => {
    const result = await createExecutor().execute({
      steps: [
        { id: "root", argv: ["node", fixturePath, "echo", "root", ""] },
        {
          id: "child",
          argv: ["node", fixturePath, "echo", "child", ""],
          depends_on: ["root"],
        },
        { id: "parallel", argv: ["node", fixturePath, "echo", "parallel", ""] },
      ],
      concurrency: 3,
    });

    expect(result.results.map(({ status }) => status)).toEqual([
      "success",
      "success",
      "success",
    ]);
    expect(result.results[1]?.depends_on).toEqual(["root"]);
    expect(result.summary.peak_concurrency).toBe(2);
  });

  it("applies a deterministic request-wide stream budget", async () => {
    const result = await createExecutor().execute({
      steps: [
        { id: "one", argv: ["node", fixturePath, "large", "100"] },
        { id: "two", argv: ["node", fixturePath, "large", "100"] },
      ],
      output: { max_total_bytes: 80, max_stream_bytes: 100, capture: "head_tail" },
    });

    expect(Buffer.byteLength(result.results[0]?.stdout ?? "")).toBeLessThanOrEqual(20);
    expect(Buffer.byteLength(result.results[1]?.stdout ?? "")).toBeLessThanOrEqual(20);
    expect(result.results.every(({ stdout_truncated }) => stdout_truncated)).toBe(true);
  });

  it("enforces one FIFO process limit across simultaneous exec requests", async () => {
    const policy = testPolicy(process.cwd(), { maxConcurrency: 2 });
    const logger = createLogger("silent");
    const runner = new ProcessRunner(logger, new ExecutionLimiter(2));
    runners.push(runner);
    const first = new ExecExecutor(policy, logger, runner);
    const second = new ExecExecutor(policy, logger, runner);
    executors.push(first, second);
    const steps = (prefix: string) =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `${prefix}-${index}`,
        argv: ["node", fixturePath, "delay", "100"],
      }));

    const [firstResult, secondResult] = await Promise.all([
      first.execute({ steps: steps("first"), concurrency: 2 }),
      second.execute({ steps: steps("second"), concurrency: 2 }),
    ]);

    expect(firstResult.results.every(({ status }) => status === "success")).toBe(true);
    expect(secondResult.results.every(({ status }) => status === "success")).toBe(true);
    expect(runner.globalPeakConcurrency).toBe(2);
    expect(
      [...firstResult.results, ...secondResult.results].some(
        ({ global_queue_wait_ms }) => global_queue_wait_ms > 0,
      ),
    ).toBe(true);
  });
});
