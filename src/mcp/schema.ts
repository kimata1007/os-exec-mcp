import { z } from "zod";

import { batchExecInputSchema } from "../validation/batch-input.js";

export { batchExecInputSchema };

const commandStatusSchema = z.enum([
  "success",
  "failed",
  "timeout",
  "cancelled",
  "skipped",
  "rejected",
  "spawn_error",
]);

export const batchExecResultSchema = z
  .object({
    request_id: z.uuid(),
    results: z.array(
      z
        .object({
          id: z.string(),
          status: commandStatusSchema,
          exit_code: z.number().int().nullable(),
          signal: z.string().nullable(),
          stdout: z.string(),
          stderr: z.string(),
          stdout_bytes: z.number().int().nonnegative(),
          stderr_bytes: z.number().int().nonnegative(),
          stdout_truncated: z.boolean(),
          stderr_truncated: z.boolean(),
          duration_ms: z.number().int().nonnegative(),
          error: z.string().nullable(),
          rejection_reason: z.string().nullable(),
        })
        .strict(),
    ),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        timed_out: z.number().int().nonnegative(),
        cancelled: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        rejected: z.number().int().nonnegative(),
        spawn_errors: z.number().int().nonnegative(),
        wall_time_ms: z.number().int().nonnegative(),
        effective_concurrency: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
