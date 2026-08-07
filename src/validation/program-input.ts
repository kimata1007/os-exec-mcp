import { z } from "zod";

import type { RuntimePolicy } from "../config/schema.js";
import type { ValidatedExecProgramInput } from "../program/types.js";
import { BatchInputError, issueMessages } from "./batch-input.js";

const executableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

export const execProgramInputSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(256 * 1024),
    allowed_executables: z.array(executableNameSchema).min(1).max(256),
    cwd: z.string().min(1).max(4096).optional(),
    limits: z
      .object({
        max_exec_calls: z.number().int().min(1).max(1024).optional(),
        max_concurrency: z.number().int().min(1).max(64).optional(),
        timeout_ms: z.number().int().min(100).max(600_000).optional(),
        memory_bytes: z
          .number()
          .int()
          .min(8 * 1024 * 1024)
          .max(1024 * 1024 * 1024)
          .optional(),
        max_return_bytes: z
          .number()
          .int()
          .min(1)
          .max(16 * 1024 * 1024)
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const programCommandOptionsSchema = z
  .object({
    cwd: z.string().min(1).max(4096).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
  })
  .strict();

export const programArgvSchema = z
  .array(z.string().max(32 * 1024))
  .min(1)
  .max(1024);

export function validateExecProgramInput(
  input: unknown,
  policy: RuntimePolicy,
): ValidatedExecProgramInput {
  const parsed = execProgramInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BatchInputError(
      "Invalid exec_program input",
      issueMessages(parsed.error),
    );
  }

  const limits = parsed.data.limits;
  const maxExecCalls = limits?.max_exec_calls ?? policy.defaultProgramMaxExecCalls;
  const maxConcurrency = limits?.max_concurrency ?? policy.defaultConcurrency;
  const timeoutMs = limits?.timeout_ms ?? policy.defaultProgramTimeoutMs;
  const memoryBytes = limits?.memory_bytes ?? policy.defaultProgramMemoryBytes;
  const maxReturnBytes =
    limits?.max_return_bytes ?? policy.defaultProgramMaxReturnBytes;
  const issues: string[] = [];
  if (maxExecCalls > policy.absoluteProgramMaxExecCalls) {
    issues.push(
      `limits.max_exec_calls: ${maxExecCalls} exceeds server limit ${policy.absoluteProgramMaxExecCalls}`,
    );
  }
  if (maxConcurrency > policy.maxConcurrency) {
    issues.push(
      `limits.max_concurrency: ${maxConcurrency} exceeds server limit ${policy.maxConcurrency}`,
    );
  }
  if (timeoutMs > policy.absoluteProgramTimeoutMs) {
    issues.push(
      `limits.timeout_ms: ${timeoutMs} exceeds server limit ${policy.absoluteProgramTimeoutMs}`,
    );
  }
  if (memoryBytes > policy.absoluteProgramMemoryBytes) {
    issues.push(
      `limits.memory_bytes: ${memoryBytes} exceeds server limit ${policy.absoluteProgramMemoryBytes}`,
    );
  }
  if (maxReturnBytes > policy.absoluteProgramMaxReturnBytes) {
    issues.push(
      `limits.max_return_bytes: ${maxReturnBytes} exceeds server limit ${policy.absoluteProgramMaxReturnBytes}`,
    );
  }
  if (issues.length > 0) {
    throw new BatchInputError("Input exceeds server policy limits", issues);
  }

  return {
    source: parsed.data.source,
    allowedExecutables: [...new Set(parsed.data.allowed_executables)],
    ...(parsed.data.cwd === undefined ? {} : { cwd: parsed.data.cwd }),
    limits: {
      maxExecCalls,
      maxConcurrency,
      timeoutMs,
      memoryBytes,
      maxReturnBytes,
    },
  };
}
