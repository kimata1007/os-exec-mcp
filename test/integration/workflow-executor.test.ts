import { afterEach, describe, expect, it } from "vitest";

import { WorkflowExecutor } from "../../src/executor/workflow-executor.js";
import { createLogger } from "../../src/observability/logger.js";
import { testPolicy } from "../helpers/policy.js";
import { fixturePath } from "../helpers/runner.js";

const executors: WorkflowExecutor[] = [];

function executor(
  policyOverrides: Parameters<typeof testPolicy>[1] = {},
): WorkflowExecutor {
  const value = new WorkflowExecutor(
    testPolicy(process.cwd(), policyOverrides),
    createLogger("silent"),
  );
  executors.push(value);
  return value;
}

function nodeCommand(id: string, arguments_: string[], dependsOn: string[] = []) {
  return {
    id,
    argv: ["node", fixturePath, ...arguments_],
    ...(dependsOn.length === 0 ? {} : { depends_on: dependsOn }),
  };
}

type Interval = {
  startedAt: number;
  endedAt: number;
};

function interval(stdout: string): Interval {
  return JSON.parse(stdout) as Interval;
}

afterEach(async () => {
  await Promise.all(executors.splice(0).map(async (value) => await value.shutdown()));
});

describe("WorkflowExecutor", () => {
  it("never exceeds the requested concurrency across ready nodes", async () => {
    const result = await executor().execute({
      commands: Array.from({ length: 6 }, (_, index) =>
        nodeCommand(`command-${index}`, ["delay", "80"]),
      ),
      concurrency: 2,
    });

    expect(result.results.every(({ status }) => status === "success")).toBe(true);
    expect(result.summary).toMatchObject({
      effective_concurrency: 2,
      peak_concurrency: 2,
    });
  });

  it("runs ready DAG nodes concurrently and unlocks a join after all dependencies", async () => {
    const result = await executor().execute({
      commands: [
        nodeCommand("root", ["delay", "80"]),
        nodeCommand("left", ["delay", "180"], ["root"]),
        nodeCommand("right", ["delay", "180"], ["root"]),
        nodeCommand("join", ["delay", "20"], ["left", "right"]),
      ],
      concurrency: 3,
    });

    const [root, left, right, join] = result.results.map((item) =>
      interval(item.stdout),
    );
    expect(root?.endedAt).toBeLessThanOrEqual(left?.startedAt ?? 0);
    expect(root?.endedAt).toBeLessThanOrEqual(right?.startedAt ?? 0);
    expect(left?.startedAt).toBeLessThan(right?.endedAt ?? 0);
    expect(right?.startedAt).toBeLessThan(left?.endedAt ?? 0);
    expect(join?.startedAt).toBeGreaterThanOrEqual(
      Math.max(left?.endedAt ?? 0, right?.endedAt ?? 0),
    );
    expect(result.results.map(({ id }) => id)).toEqual([
      "root",
      "left",
      "right",
      "join",
    ]);
    expect(result.summary).toMatchObject({
      succeeded: 4,
      peak_concurrency: 2,
    });
  });

  it("skips only the failed branch while independent branches continue", async () => {
    const result = await executor().execute({
      commands: [
        nodeCommand("failed", ["exit", "5"]),
        nodeCommand("blocked", ["echo", "must-not-run", ""], ["failed"]),
        nodeCommand("descendant", ["echo", "must-not-run", ""], ["blocked"]),
        nodeCommand("independent", ["echo", "ok", ""]),
      ],
      concurrency: 2,
      failure_mode: "continue",
    });

    expect(result.results.map(({ status }) => status)).toEqual([
      "failed",
      "skipped",
      "skipped",
      "success",
    ]);
    expect(result.results[1]).toMatchObject({
      depends_on: ["failed"],
      blocked_by: ["failed"],
    });
    expect(result.results[2]).toMatchObject({
      depends_on: ["blocked"],
      blocked_by: ["blocked"],
    });
    expect(result.results[3]?.stdout).toBe("ok");
  });

  it("treats a policy rejection as a failed dependency without stopping other branches", async () => {
    const result = await executor().execute({
      commands: [
        { id: "rejected", argv: ["not-allowed"] },
        nodeCommand("blocked", ["echo", "must-not-run", ""], ["rejected"]),
        nodeCommand("independent", ["echo", "ok", ""]),
      ],
      concurrency: 2,
    });

    expect(result.results[0]).toMatchObject({
      status: "rejected",
      rejection_reason: "command_not_allowed",
    });
    expect(result.results[1]).toMatchObject({
      status: "skipped",
      blocked_by: ["rejected"],
    });
    expect(result.results[2]?.status).toBe("success");
  });

  it("cancels running work and skips all unstarted nodes in fail-fast mode", async () => {
    const result = await executor().execute({
      commands: [
        nodeCommand("failed", ["exit", "3"]),
        nodeCommand("running", ["delay", "2000"]),
        nodeCommand("queued", ["echo", "must-not-run", ""]),
        nodeCommand("dependent", ["echo", "must-not-run", ""], ["running"]),
      ],
      concurrency: 2,
      failure_mode: "fail_fast",
    });

    expect(result.results.map(({ status }) => status)).toEqual([
      "failed",
      "cancelled",
      "skipped",
      "skipped",
    ]);
  });

  it("cancels running and unstarted nodes when the request is aborted", async () => {
    const controller = new AbortController();
    const running = executor().execute(
      {
        commands: [
          nodeCommand("one", ["delay", "2000"]),
          nodeCommand("two", ["delay", "2000"], ["one"]),
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
});
