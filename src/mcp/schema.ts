import { z } from "zod";

import { batchExecInputSchema } from "../validation/batch-input.js";
import { execInputSchema } from "../validation/exec-input.js";
import { execProgramInputSchema } from "../validation/program-input.js";
import { workflowExecInputSchema } from "../validation/workflow-input.js";

export {
  batchExecInputSchema,
  execInputSchema,
  execProgramInputSchema,
  workflowExecInputSchema,
};

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
          global_queue_wait_ms: z.number().int().nonnegative(),
          stdout_resource: z.string().optional(),
          stderr_resource: z.string().optional(),
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

export const workflowExecResultSchema = z
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
          global_queue_wait_ms: z.number().int().nonnegative(),
          stdout_resource: z.string().optional(),
          stderr_resource: z.string().optional(),
          depends_on: z.array(z.string()),
          blocked_by: z.array(z.string()),
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
        peak_concurrency: z.number().int().nonnegative(),
        global_peak_concurrency: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const execResultSchema = z
  .object({
    request_id: z.uuid(),
    output_mode: z.enum(["compact", "debug"]),
    results: z.array(
      z
        .object({
          id: z.string(),
          status: commandStatusSchema,
          exit_code: z.number().int().nullable().optional(),
          signal: z.string().nullable().optional(),
          stdout: z.string().optional(),
          stderr: z.string().optional(),
          stdout_bytes: z.number().int().nonnegative().optional(),
          stderr_bytes: z.number().int().nonnegative().optional(),
          stdout_truncated: z.boolean().optional(),
          stderr_truncated: z.boolean().optional(),
          duration_ms: z.number().int().nonnegative(),
          error: z.string().nullable().optional(),
          rejection_reason: z.string().nullable().optional(),
          global_queue_wait_ms: z.number().int().nonnegative().optional(),
          depends_on: z.array(z.string()).optional(),
          blocked_by: z.array(z.string()).optional(),
          stdout_resource: z.string().optional(),
          stderr_resource: z.string().optional(),
        })
        .strict(),
    ),
    summary: z
      .object({
        total: z.number().int().nonnegative(),
        succeeded: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative().optional(),
        timed_out: z.number().int().nonnegative().optional(),
        cancelled: z.number().int().nonnegative().optional(),
        skipped: z.number().int().nonnegative().optional(),
        rejected: z.number().int().nonnegative().optional(),
        spawn_errors: z.number().int().nonnegative().optional(),
        wall_time_ms: z.number().int().nonnegative(),
        effective_concurrency: z.number().int().positive(),
        peak_concurrency: z.number().int().nonnegative(),
        global_peak_concurrency: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const execProgramResultSchema = z
  .object({
    request_id: z.uuid(),
    value: z.unknown(),
    summary: z
      .object({
        exec_calls: z.number().int().nonnegative(),
        wall_time_ms: z.number().int().nonnegative(),
        global_peak_concurrency: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
