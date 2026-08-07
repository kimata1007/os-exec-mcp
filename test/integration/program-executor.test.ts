import { afterEach, describe, expect, it } from "vitest";

import { ExecutionLimiter } from "../../src/executor/execution-limiter.js";
import { ProcessRunner } from "../../src/executor/process-runner.js";
import { createLogger } from "../../src/observability/logger.js";
import { ProgramExecutor } from "../../src/program/program-executor.js";
import { fixturePath } from "../helpers/runner.js";
import { testPolicy } from "../helpers/policy.js";

const runners: ProcessRunner[] = [];

afterEach(async () => {
  await Promise.all(runners.splice(0).map(async (runner) => await runner.shutdown()));
});

function executor(): ProgramExecutor {
  const policy = testPolicy(process.cwd());
  const logger = createLogger("silent");
  const runner = new ProcessRunner(logger, new ExecutionLimiter(policy.maxConcurrency));
  runners.push(runner);
  return new ProgramExecutor(policy, logger, runner);
}

function sourceArgv(mode: string, ...values: string[]): string {
  return JSON.stringify(["node", fixturePath, mode, ...values]);
}

describe("ProgramExecutor", () => {
  it("uses command output inside the sandbox and returns only finish(value)", async () => {
    const result = await executor().execute({
      source: `
        const command = await exec(${sourceArgv("echo", "alpha\nbeta", "")});
        finish({ status: command.status, lines: lines(command) });
      `,
      allowed_executables: ["node"],
    });

    expect(result.value).toEqual({ status: "success", lines: ["alpha", "beta"] });
    expect(result.summary.exec_calls).toBe(1);
  });

  it("runs bounded parallel operations and preserves their order", async () => {
    const result = await executor().execute({
      source: `
        const results = await parallel([
          ${sourceArgv("echo", "one", "")},
          ${sourceArgv("echo", "two", "")},
          ${sourceArgv("echo", "three", "")}
        ], 2);
        finish(results.map((result) => result.stdout));
      `,
      allowed_executables: ["node"],
      limits: { max_concurrency: 2 },
    });

    expect(result.value).toEqual(["one", "two", "three"]);
    expect(result.summary.exec_calls).toBe(3);
  });

  it("does not expose Node, filesystem, network, or environment globals", async () => {
    const result = await executor().execute({
      source: `finish({
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        Buffer: typeof Buffer,
        Deno: typeof Deno
      });`,
      allowed_executables: ["node"],
    });

    expect(result.value).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      Buffer: "undefined",
      Deno: "undefined",
    });
  });

  it("hard-terminates an infinite loop", async () => {
    await expect(
      executor().execute({
        source: "while (true) {}",
        allowed_executables: ["node"],
        limits: { timeout_ms: 200 },
      }),
    ).rejects.toMatchObject({ code: "timeout" });
  });

  it("terminates the worker and child command on cancellation", async () => {
    const controller = new AbortController();
    const running = executor().execute(
      {
        source: `const result = await exec(${sourceArgv("delay", "2000")}); finish(result);`,
        allowed_executables: ["node"],
      },
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 150);

    await expect(running).rejects.toMatchObject({ code: "cancelled" });
  });

  it("rejects finish while an unawaited command is still pending", async () => {
    await expect(
      executor().execute({
        source: `exec(${sourceArgv("delay", "2000")}); finish("too-early");`,
        allowed_executables: ["node"],
      }),
    ).rejects.toThrow("still pending");
  });

  it("stops programs that exhaust the QuickJS memory budget", async () => {
    await expect(
      executor().execute({
        source: `let value = "x"; while (true) value = value + value;`,
        allowed_executables: ["node"],
        limits: { memory_bytes: 8 * 1024 * 1024, timeout_ms: 2000 },
      }),
    ).rejects.toMatchObject({ code: "memory_limit" });
  });

  it("enforces exec-call, executable, and return-size limits", async () => {
    await expect(
      executor().execute({
        source: `
          await exec(${sourceArgv("echo", "one", "")});
          await exec(${sourceArgv("echo", "two", "")});
          finish("unreachable");
        `,
        allowed_executables: ["node"],
        limits: { max_exec_calls: 1 },
      }),
    ).rejects.toThrow("max_exec_calls");

    const rejected = await executor().execute({
      source: `const result = await exec(["other"]); finish(result);`,
      allowed_executables: ["node"],
    });
    expect(rejected.value).toMatchObject({
      status: "rejected",
      rejection_reason: "program_executable_not_allowed",
    });

    const policyRejected = await executor().execute({
      source: `const result = await exec(["not-allowed"]); finish(result);`,
      allowed_executables: ["not-allowed"],
    });
    expect(policyRejected.value).toMatchObject({
      status: "rejected",
      rejection_reason: "command_not_allowed",
    });

    await expect(
      executor().execute({
        source: `finish("${"x".repeat(64)}");`,
        allowed_executables: ["node"],
        limits: { max_return_bytes: 16 },
      }),
    ).rejects.toMatchObject({
      code: "result_too_large",
    });
  });
});
