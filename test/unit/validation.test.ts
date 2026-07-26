import { describe, expect, it } from "vitest";

import { validateBatchInput } from "../../src/validation/batch-input.js";
import { testPolicy } from "../helpers/policy.js";

const policy = testPolicy(process.cwd(), {
  maxBatchSize: 2,
  maxConcurrency: 2,
  defaultConcurrency: 2,
  maxTimeoutMs: 5_000,
  defaultMaxOutputBytes: 512,
  absoluteMaxOutputBytes: 1024,
});

function expectInvalid(input: unknown, fragment: string): void {
  expect(() => validateBatchInput(input, policy)).toThrow(fragment);
}

describe("batch input validation", () => {
  it("applies server defaults", () => {
    const value = validateBatchInput(
      { commands: [{ id: "one", argv: ["node", "--version"] }] },
      policy,
    );

    expect(value.concurrency).toBe(1);
    expect(value.failureMode).toBe("continue");
    expect(value.commands[0]?.timeoutMs).toBe(policy.defaultTimeoutMs);
  });

  it("rejects an empty command list", () => {
    expectInvalid({ commands: [] }, "Invalid batch_exec input");
  });

  it("rejects a batch over the server maximum", () => {
    expectInvalid(
      {
        commands: [
          { id: "one", argv: ["node"] },
          { id: "two", argv: ["node"] },
          { id: "three", argv: ["node"] },
        ],
      },
      "Input exceeds server policy limits",
    );
  });

  it("rejects duplicate identifiers", () => {
    expectInvalid(
      {
        commands: [
          { id: "same", argv: ["node"] },
          { id: "same", argv: ["node"] },
        ],
      },
      "Invalid batch_exec input",
    );
  });

  it("rejects an empty argv", () => {
    expectInvalid({ commands: [{ id: "one", argv: [] }] }, "Invalid batch_exec input");
  });

  it("rejects an oversized argument", () => {
    expectInvalid(
      { commands: [{ id: "one", argv: ["node", "x".repeat(4097)] }] },
      "Invalid batch_exec input",
    );
  });

  it("rejects an invalid failure mode", () => {
    expectInvalid(
      {
        commands: [{ id: "one", argv: ["node"] }],
        failure_mode: "sometimes",
      },
      "Invalid batch_exec input",
    );
  });

  it.each([0, 1.5, 3])("rejects invalid concurrency %s", (concurrency) => {
    expectInvalid(
      { commands: [{ id: "one", argv: ["node"] }], concurrency },
      concurrency === 3
        ? "Input exceeds server policy limits"
        : "Invalid batch_exec input",
    );
  });

  it.each([99, 5_001])("rejects invalid timeout %s", (timeout_ms) => {
    expectInvalid(
      { commands: [{ id: "one", argv: ["node"], timeout_ms }] },
      timeout_ms === 99
        ? "Invalid batch_exec input"
        : "Input exceeds server policy limits",
    );
  });

  it("rejects NUL characters", () => {
    expectInvalid(
      { commands: [{ id: "one", argv: ["node", "bad\0value"] }] },
      "Invalid batch_exec input",
    );
  });

  it("rejects an invalid environment variable name", () => {
    expectInvalid(
      { commands: [{ id: "one", argv: ["node"], env: { "bad-name": "x" } }] },
      "Invalid batch_exec input",
    );
  });

  it("rejects output above the absolute maximum", () => {
    expectInvalid(
      {
        commands: [{ id: "one", argv: ["node"] }],
        max_output_bytes: 1025,
      },
      "Input exceeds server policy limits",
    );
  });
});
