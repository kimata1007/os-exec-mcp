import { describe, expect, it } from "vitest";

import { validateWorkflowInput } from "../../src/validation/workflow-input.js";
import { testPolicy } from "../helpers/policy.js";

const policy = testPolicy(process.cwd(), {
  maxBatchSize: 4,
  maxConcurrency: 3,
  defaultConcurrency: 2,
  maxTimeoutMs: 5_000,
  defaultMaxOutputBytes: 512,
  absoluteMaxOutputBytes: 1024,
});

function expectInvalid(input: unknown, fragment: string): void {
  expect(() => validateWorkflowInput(input, policy)).toThrow(fragment);
}

describe("workflow input validation", () => {
  it("applies defaults and preserves direct dependencies", () => {
    const value = validateWorkflowInput(
      {
        commands: [
          { id: "install", argv: ["node", "--version"] },
          {
            id: "test",
            argv: ["node", "--version"],
            depends_on: ["install"],
          },
        ],
      },
      policy,
    );

    expect(value.concurrency).toBe(2);
    expect(value.failureMode).toBe("continue");
    expect(value.commands.map(({ dependsOn }) => dependsOn)).toEqual([[], ["install"]]);
  });

  it("rejects unknown dependencies", () => {
    expectInvalid(
      {
        commands: [
          {
            id: "test",
            argv: ["node"],
            depends_on: ["missing"],
          },
        ],
      },
      "Invalid workflow_exec input",
    );
  });

  it("rejects self-dependencies", () => {
    expectInvalid(
      {
        commands: [
          {
            id: "test",
            argv: ["node"],
            depends_on: ["test"],
          },
        ],
      },
      "Invalid workflow_exec input",
    );
  });

  it("rejects duplicate dependencies", () => {
    expectInvalid(
      {
        commands: [
          { id: "install", argv: ["node"] },
          {
            id: "test",
            argv: ["node"],
            depends_on: ["install", "install"],
          },
        ],
      },
      "Invalid workflow_exec input",
    );
  });

  it("rejects dependency cycles", () => {
    expectInvalid(
      {
        commands: [
          { id: "one", argv: ["node"], depends_on: ["three"] },
          { id: "two", argv: ["node"], depends_on: ["one"] },
          { id: "three", argv: ["node"], depends_on: ["two"] },
        ],
      },
      "Invalid workflow_exec input",
    );
  });

  it("enforces workflow and concurrency policy limits", () => {
    expectInvalid(
      {
        commands: Array.from({ length: 5 }, (_, index) => ({
          id: `command-${index}`,
          argv: ["node"],
        })),
      },
      "Input exceeds server policy limits",
    );
    expectInvalid(
      {
        commands: [{ id: "one", argv: ["node"] }],
        concurrency: 4,
      },
      "Input exceeds server policy limits",
    );
  });
});
