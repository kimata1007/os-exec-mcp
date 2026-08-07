import { describe, expect, it } from "vitest";

import { validateExecInput } from "../../src/validation/exec-input.js";
import { testPolicy } from "../helpers/policy.js";

describe("exec validation", () => {
  it("uses one schema for an independent batch and a DAG", () => {
    const result = validateExecInput(
      {
        steps: [
          { id: "one", argv: ["node"] },
          { id: "two", argv: ["node"], depends_on: ["one"] },
        ],
        output: { max_total_bytes: 400, max_stream_bytes: 500 },
      },
      testPolicy(process.cwd()),
    );

    expect(result.steps[1]?.dependsOn).toEqual(["one"]);
    expect(result.output).toMatchObject({
      maxTotalBytes: 400,
      maxStreamBytes: 100,
      capture: "head_tail",
      stripAnsi: true,
    });
  });

  it("rejects dependency cycles and request-wide output limits", () => {
    const policy = testPolicy(process.cwd(), { absoluteMaxTotalOutputBytes: 100 });
    expect(() =>
      validateExecInput(
        {
          steps: [
            { id: "one", argv: ["node"], depends_on: ["two"] },
            { id: "two", argv: ["node"], depends_on: ["one"] },
          ],
        },
        policy,
      ),
    ).toThrow("Invalid exec input");
    expect(() =>
      validateExecInput(
        {
          steps: [{ id: "one", argv: ["node"] }],
          output: { max_total_bytes: 101 },
        },
        policy,
      ),
    ).toThrow("Input exceeds server policy limits");
  });
});
