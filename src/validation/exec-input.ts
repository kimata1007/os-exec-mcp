import { z } from "zod";

import type { RuntimePolicy } from "../config/schema.js";
import type { ValidatedExecInput } from "../executor/types.js";
import { BatchInputError, issueMessages } from "./batch-input.js";
import { workflowCommandInputSchema } from "./workflow-input.js";

export const outputOptionsSchema = z
  .object({
    mode: z.enum(["compact", "debug"]).optional(),
    max_total_bytes: z
      .number()
      .int()
      .min(2)
      .max(16 * 1024 * 1024)
      .optional(),
    max_stream_bytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .optional(),
    capture: z.enum(["head_tail", "head"]).optional(),
    strip_ansi: z.boolean().optional(),
  })
  .strict();

export const execInputSchema = z
  .object({
    steps: z.array(workflowCommandInputSchema).min(1).max(256),
    concurrency: z.number().int().min(1).max(64).optional(),
    failure_mode: z.enum(["continue", "fail_fast"]).optional(),
    output: outputOptionsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = new Set<string>();
    value.steps.forEach((step, index) => {
      if (identifiers.has(step.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate step id: ${step.id}`,
          path: ["steps", index, "id"],
        });
      }
      identifiers.add(step.id);
    });

    value.steps.forEach((step, stepIndex) => {
      const dependencies = new Set<string>();
      (step.depends_on ?? []).forEach((dependency, dependencyIndex) => {
        const path = ["steps", stepIndex, "depends_on", dependencyIndex];
        if (dependencies.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `duplicate dependency: ${dependency}`,
            path,
          });
        }
        dependencies.add(dependency);
        if (dependency === step.id) {
          context.addIssue({
            code: "custom",
            message: "a step cannot depend on itself",
            path,
          });
        } else if (!identifiers.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `unknown dependency: ${dependency}`,
            path,
          });
        }
      });
    });

    if (context.issues.length > 0) {
      return;
    }
    const dependenciesById = new Map(
      value.steps.map((step) => [step.id, step.depends_on ?? []]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];
    const visit = (identifier: string): boolean => {
      if (visiting.has(identifier)) {
        const cycleStart = stack.indexOf(identifier);
        context.addIssue({
          code: "custom",
          message: `dependency cycle detected: ${[...stack.slice(cycleStart), identifier].join(" -> ")}`,
          path: ["steps"],
        });
        return false;
      }
      if (visited.has(identifier)) {
        return true;
      }
      visiting.add(identifier);
      stack.push(identifier);
      for (const dependency of dependenciesById.get(identifier) ?? []) {
        if (!visit(dependency)) {
          return false;
        }
      }
      stack.pop();
      visiting.delete(identifier);
      visited.add(identifier);
      return true;
    };
    for (const identifier of identifiers) {
      if (!visit(identifier)) {
        break;
      }
    }
  });

export function validateExecInput(
  input: unknown,
  policy: RuntimePolicy,
): ValidatedExecInput {
  const parsed = execInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BatchInputError("Invalid exec input", issueMessages(parsed.error));
  }

  const issues: string[] = [];
  if (parsed.data.steps.length > policy.maxBatchSize) {
    issues.push(
      `steps: step count ${parsed.data.steps.length} exceeds server limit ${policy.maxBatchSize}`,
    );
  }
  const requestedConcurrency = parsed.data.concurrency ?? policy.defaultConcurrency;
  if (requestedConcurrency > policy.maxConcurrency) {
    issues.push(
      `concurrency: ${requestedConcurrency} exceeds server limit ${policy.maxConcurrency}`,
    );
  }
  const maxTotalBytes =
    parsed.data.output?.max_total_bytes ?? policy.defaultMaxTotalOutputBytes;
  if (maxTotalBytes > policy.absoluteMaxTotalOutputBytes) {
    issues.push(
      `output.max_total_bytes: ${maxTotalBytes} exceeds server limit ${policy.absoluteMaxTotalOutputBytes}`,
    );
  }
  const requestedMaxStreamBytes =
    parsed.data.output?.max_stream_bytes ?? policy.defaultMaxOutputBytes;
  if (requestedMaxStreamBytes > policy.absoluteMaxOutputBytes) {
    issues.push(
      `output.max_stream_bytes: ${requestedMaxStreamBytes} exceeds server limit ${policy.absoluteMaxOutputBytes}`,
    );
  }
  parsed.data.steps.forEach((step, index) => {
    const timeoutMs = step.timeout_ms ?? policy.defaultTimeoutMs;
    if (timeoutMs > policy.maxTimeoutMs) {
      issues.push(
        `steps.${index}.timeout_ms: ${timeoutMs} exceeds server limit ${policy.maxTimeoutMs}`,
      );
    }
  });
  const fairStreamBytes = Math.floor(maxTotalBytes / (parsed.data.steps.length * 2));
  if (fairStreamBytes < 1) {
    issues.push(
      "output.max_total_bytes is too small for every step's stdout and stderr",
    );
  }
  if (issues.length > 0) {
    throw new BatchInputError("Input exceeds server policy limits", issues);
  }

  return {
    steps: parsed.data.steps.map((step) => ({
      id: step.id,
      argv: step.argv,
      ...(step.cwd === undefined ? {} : { cwd: step.cwd }),
      timeoutMs: step.timeout_ms ?? policy.defaultTimeoutMs,
      env: step.env ?? {},
      dependsOn: step.depends_on ?? [],
    })),
    concurrency: Math.min(requestedConcurrency, parsed.data.steps.length),
    failureMode: parsed.data.failure_mode ?? "continue",
    output: {
      mode: parsed.data.output?.mode ?? policy.defaultOutputMode,
      maxTotalBytes,
      maxStreamBytes: Math.min(requestedMaxStreamBytes, fairStreamBytes),
      capture: parsed.data.output?.capture ?? "head_tail",
      stripAnsi: parsed.data.output?.strip_ansi ?? true,
    },
  };
}
