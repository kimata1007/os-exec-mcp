import { z } from "zod";

import type { RuntimePolicy } from "../config/schema.js";
import type { ValidatedBatchInput } from "../executor/types.js";

const containsNoNul = (value: string): boolean => !value.includes("\0");

export const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/,
    "must start with an alphanumeric character and contain only safe identifier characters",
  );

const argumentSchema = z
  .string()
  .max(4096)
  .refine(containsNoNul, "must not contain a NUL character");

const environmentNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "is not a valid environment variable name");

const environmentValueSchema = z
  .string()
  .max(16_384)
  .refine(containsNoNul, "must not contain a NUL character");

export const commandInputSchema = z
  .object({
    id: identifierSchema,
    argv: z
      .array(argumentSchema)
      .min(1)
      .max(128)
      .refine((argv) => (argv[0]?.length ?? 0) > 0, "argv[0] must not be empty"),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine(containsNoNul, "must not contain a NUL character")
      .optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
    env: z
      .record(environmentNameSchema, environmentValueSchema)
      .refine((value) => Object.keys(value).length <= 64, "has too many entries")
      .optional(),
  })
  .strict();

export const batchExecInputSchema = z
  .object({
    commands: z.array(commandInputSchema).min(1).max(256),
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
  });

export class BatchInputError extends Error {
  public override readonly name = "BatchInputError";

  public constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
  }
}

export function issueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const location = issue.path.length === 0 ? "input" : issue.path.join(".");
    return `${location}: ${issue.message}`;
  });
}

export function validateBatchInput(
  input: unknown,
  policy: RuntimePolicy,
): ValidatedBatchInput {
  const parsed = batchExecInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new BatchInputError("Invalid batch_exec input", issueMessages(parsed.error));
  }

  const issues: string[] = [];
  if (parsed.data.commands.length > policy.maxBatchSize) {
    issues.push(
      `commands: batch size ${parsed.data.commands.length} exceeds server limit ${policy.maxBatchSize}`,
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
    })),
    concurrency: Math.min(requestedConcurrency, parsed.data.commands.length),
    failureMode: parsed.data.failure_mode ?? "continue",
    maxOutputBytes,
  };
}
