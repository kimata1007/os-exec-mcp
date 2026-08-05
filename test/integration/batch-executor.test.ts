import { performance } from "node:perf_hooks";

import { afterEach, describe, expect, it } from "vitest";

import { BatchExecutor } from "../../src/executor/batch-executor.js";
import { createLogger } from "../../src/observability/logger.js";
import { fixturePath } from "../helpers/runner.js";
import { testPolicy } from "../helpers/policy.js";

const executors: BatchExecutor[] = [];

function executor(
  policyOverrides: Parameters<typeof testPolicy>[1] = {},
): BatchExecutor {
  const value = new BatchExecutor(
    testPolicy(process.cwd(), policyOverrides),
    createLogger("silent"),
  );
  executors.push(value);
  return value;
}

function nodeCommand(id: string, arguments_: string[]) {
  return {
    id,
    argv: ["node", fixturePath, ...arguments_],
  };
}

afterEach(async () => {
  await Promise.all(executors.splice(0).map(async (value) => await value.shutdown()));
});

describe("BatchExecutor", () => {
  it("preserves input order even when completion order differs", async () => {
    const result = await executor().execute({
      commands: [
        nodeCommand("slow", ["delay", "250"]),
        nodeCommand("fast", ["delay", "40"]),
        nodeCommand("middle", ["delay", "120"]),
      ],
      concurrency: 3,
    });

    expect(result.results.map(({ id }) => id)).toEqual(["slow", "fast", "middle"]);
    expect(result.results.every(({ status }) => status === "success")).toBe(true);
  });

  it("runs independent commands in parallel within one batch", async () => {
    const batchExecutor = executor();
    const commands = ["one", "two", "three"].map((id) =>
      nodeCommand(id, ["delay", "180"]),
    );

    const sequentialStart = performance.now();
    await batchExecutor.execute({ commands, concurrency: 1 });
    const sequentialMs = performance.now() - sequentialStart;

    const parallelStart = performance.now();
    await batchExecutor.execute({ commands, concurrency: 3 });
    const parallelMs = performance.now() - parallelStart;

    expect(parallelMs).toBeLessThan(sequentialMs * 0.8);
  });

  it("never exceeds the requested concurrency", async () => {
    const result = await executor().execute({
      commands: Array.from({ length: 6 }, (_, index) =>
        nodeCommand(`command-${index}`, ["delay", "180"]),
      ),
      concurrency: 2,
    });

    const intervals = result.results.map((item) => {
      const parsed = JSON.parse(item.stdout) as {
        startedAt: number;
        endedAt: number;
      };
      return parsed;
    });
    const events = intervals
      .flatMap(({ startedAt, endedAt }) => [
        { time: startedAt, delta: 1 },
        { time: endedAt, delta: -1 },
      ])
      .sort((left, right) => left.time - right.time || left.delta - right.delta);

    let active = 0;
    let maximumActive = 0;
    for (const event of events) {
      active += event.delta;
      maximumActive = Math.max(maximumActive, active);
    }

    expect(maximumActive).toBe(2);
    expect(result.summary.effective_concurrency).toBe(2);
  });

  it("continues independent work after a partial failure", async () => {
    const result = await executor().execute({
      commands: [
        nodeCommand("failed", ["exit", "5"]),
        nodeCommand("success", ["echo", "ok", ""]),
      ],
      concurrency: 2,
      failure_mode: "continue",
    });

    expect(result.results.map(({ status }) => status)).toEqual(["failed", "success"]);
    expect(result.summary).toMatchObject({
      total: 2,
      succeeded: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it("cancels in-flight work and skips queued work in fail-fast mode", async () => {
    const result = await executor().execute({
      commands: [
        nodeCommand("failed", ["exit", "3"]),
        nodeCommand("running", ["delay", "2000"]),
        nodeCommand("queued", ["echo", "should-not-run", ""]),
      ],
      concurrency: 2,
      failure_mode: "fail_fast",
    });

    expect(result.results[0]?.status).toBe("failed");
    expect(result.results[1]?.status).toBe("cancelled");
    expect(result.results[2]?.status).toBe("skipped");
    expect(result.summary.cancelled).toBe(1);
    expect(result.summary.skipped).toBe(1);
  });

  it("represents policy rejection without failing the whole tool operation", async () => {
    const result = await executor().execute({
      commands: [
        { id: "rejected", argv: ["not-allowed"] },
        nodeCommand("allowed", ["echo", "ok", ""]),
      ],
      concurrency: 2,
      failure_mode: "continue",
    });

    expect(result.results[0]).toMatchObject({
      status: "rejected",
      rejection_reason: "command_not_allowed",
    });
    expect(result.results[1]?.status).toBe("success");
    expect(result.summary.rejected).toBe(1);
  });

  it("passes metacharacters as literal argv data without invoking a shell", async () => {
    const metacharacters = "$(echo injected); `echo also-injected` | bad > file";
    const result = await executor().execute({
      commands: [nodeCommand("literal", ["echo", metacharacters, ""])],
    });

    expect(result.results[0]).toMatchObject({
      status: "success",
      stdout: metacharacters,
    });
  });

  it("cancels running and unstarted commands when the request is aborted", async () => {
    const controller = new AbortController();
    const running = executor().execute(
      {
        commands: [
          nodeCommand("one", ["delay", "2000"]),
          nodeCommand("two", ["delay", "2000"]),
          nodeCommand("three", ["delay", "2000"]),
        ],
        concurrency: 2,
      },
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 120);

    const result = await running;
    expect(result.results.map(({ status }) => status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
  });

  it("enforces the server concurrency and batch limits", async () => {
    const limited = executor({ maxConcurrency: 1, maxBatchSize: 1 });

    await expect(
      limited.execute({
        commands: [nodeCommand("one", ["echo"]), nodeCommand("two", ["echo"])],
      }),
    ).rejects.toThrow("Input exceeds server policy limits");
    await expect(
      limited.execute({
        commands: [nodeCommand("one", ["echo"])],
        concurrency: 2,
      }),
    ).rejects.toThrow("Input exceeds server policy limits");
  });
});
