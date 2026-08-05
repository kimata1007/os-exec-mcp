import { z } from "zod";

import type { RuntimePolicy } from "../config/schema.js";
import type { ValidatedWorkflowInput } from "../executor/types.js";
import {
  BatchInputError,
  commandInputSchema,
  identifierSchema,
  issueMessages,
} from "./batch-input.js";

export const workflowCommandInputSchema = commandInputSchema.extend({
  depends_on: z.array(identifierSchema).max(256).optional(),
});

export const workflowExecInputSchema = z
  .object({
    commands: z.array(workflowCommandInputSchema).min(1).max(256),
    concurrency: z.number().int().min(1).max(64).optional(),
    failure_mode: z.enum(["continue", "fail_fast"]).optional(),
    max_output_bytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const identifiers = new Set<string>();
    value.commands.forEach((command, index) => {
      if (identifiers.has(command.id)) {
        context.addIssue({
          code: "custom",
          message: `duplicate command id: ${command.id}`,
          path: ["commands", index, "id"],
        });
      }
      identifiers.add(command.id);
    });

    value.commands.forEach((command, commandIndex) => {
      const dependencies = new Set<string>();
      (command.depends_on ?? []).forEach((dependency, dependencyIndex) => {
        const path = ["commands", commandIndex, "depends_on", dependencyIndex];
        if (dependencies.has(dependency)) {
          context.addIssue({
            code: "custom",
            message: `duplicate dependency: ${dependency}`,
            path,
          });
        }
        dependencies.add(dependency);

        if (dependency === command.id) {
          context.addIssue({
            code: "custom",
            message: "a command cannot depend on itself",
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
      value.commands.map((command) => [command.id, command.depends_on ?? []]),
    );
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const stack: string[] = [];

    const visit = (identifier: string): boolean => {
      if (visiting.has(identifier)) {
        const cycleStart = stack.indexOf(identifier);
        const cycle = [...stack.slice(cycleStart), identifier];
        context.addIssue({
          code: "custom",
          message: `dependency cycle detected: ${cycle.join(" -> ")}`,
          path: ["commands"],
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

export function validateWorkflowInput(
  input: unknown,
  policy: RuntimePolicy,
): ValidatedWorkflowInput {
  const parsed = workflowExecInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BatchInputError(
      "Invalid workflow_exec input",
      issueMessages(parsed.error),
    );
  }

  const issues: string[] = [];
  if (parsed.data.commands.length > policy.maxBatchSize) {
    issues.push(
      `commands: workflow size ${parsed.data.commands.length} exceeds server limit ${policy.maxBatchSize}`,
    );
  }

  const requestedConcurrency = parsed.data.concurrency ?? policy.defaultConcurrency;
  if (requestedConcurrency > policy.maxConcurrency) {
    issues.push(
      `concurrency: ${requestedConcurrency} exceeds server limit ${policy.maxConcurrency}`,
    );
  }

  const maxOutputBytes = parsed.data.max_output_bytes ?? policy.defaultMaxOutputBytes;
  if (maxOutputBytes > policy.absoluteMaxOutputBytes) {
    issues.push(
      `max_output_bytes: ${maxOutputBytes} exceeds server limit ${policy.absoluteMaxOutputBytes}`,
    );
  }

  parsed.data.commands.forEach((command, index) => {
    const timeoutMs = command.timeout_ms ?? policy.defaultTimeoutMs;
    if (timeoutMs > policy.maxTimeoutMs) {
      issues.push(
        `commands.${index}.timeout_ms: ${timeoutMs} exceeds server limit ${policy.maxTimeoutMs}`,
      );
    }
  });

  if (issues.length > 0) {
    throw new BatchInputError("Input exceeds server policy limits", issues);
  }

  return {
    commands: parsed.data.commands.map((command) => ({
      id: command.id,
      argv: command.argv,
      ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      timeoutMs: command.timeout_ms ?? policy.defaultTimeoutMs,
      env: command.env ?? {},
      dependsOn: command.depends_on ?? [],
    })),
    concurrency: Math.min(requestedConcurrency, parsed.data.commands.length),
    failureMode: parsed.data.failure_mode ?? "continue",
    maxOutputBytes,
  };
}
