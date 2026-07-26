import { z } from "zod";

export const logLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]);
export type LogLevel = z.infer<typeof logLevelSchema>;
export const commandModeSchema = z.enum(["allowlist", "denylist"]);
export type CommandMode = z.infer<typeof commandModeSchema>;

const executableNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/);

export const commandPolicySchema = z
  .object({
    allowed: z.boolean().default(false),
    path: z.string().min(1).max(4096).optional(),
    allowedSubcommands: z.array(z.string().min(1).max(128)).max(128).optional(),
    readOnly: z.boolean().default(false),
  })
  .strict();

export type CommandPolicy = z.infer<typeof commandPolicySchema>;

export const policyFileSchema = z
  .object({
    workspaceRoots: z.array(z.string().min(1).max(4096)).min(1).max(32).default(["."]),
    maxBatchSize: z.number().int().min(1).max(256).default(16),
    maxConcurrency: z.number().int().min(1).max(64).default(16),
    defaultConcurrency: z.number().int().min(1).max(64).default(8),
    defaultTimeoutMs: z.number().int().min(100).max(600_000).default(10_000),
    maxTimeoutMs: z.number().int().min(100).max(600_000).default(60_000),
    defaultMaxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(64 * 1024),
    absoluteMaxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
    allowedEnvironmentKeys: z
      .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
      .max(64)
      .default([]),
    trustedExecutableDirectories: z
      .array(z.string().min(1).max(4096))
      .max(64)
      .optional(),
    inheritExecutablePath: z.boolean().default(false),
    commandMode: commandModeSchema.default("allowlist"),
    deniedCommands: z.array(executableNameSchema).max(256).default([]),
    commands: z.record(z.string().min(1).max(128), commandPolicySchema).default({}),
    logLevel: logLevelSchema.default("info"),
    readOnly: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.defaultConcurrency > value.maxConcurrency) {
      context.addIssue({
        code: "custom",
        message: "defaultConcurrency must not exceed maxConcurrency",
        path: ["defaultConcurrency"],
      });
    }
    if (value.defaultTimeoutMs > value.maxTimeoutMs) {
      context.addIssue({
        code: "custom",
        message: "defaultTimeoutMs must not exceed maxTimeoutMs",
        path: ["defaultTimeoutMs"],
      });
    }
    if (value.defaultMaxOutputBytes > value.absoluteMaxOutputBytes) {
      context.addIssue({
        code: "custom",
        message: "defaultMaxOutputBytes must not exceed absoluteMaxOutputBytes",
        path: ["defaultMaxOutputBytes"],
      });
    }
  });

export type PolicyFile = z.infer<typeof policyFileSchema>;

export type RuntimePolicy = Omit<
  PolicyFile,
  "workspaceRoots" | "trustedExecutableDirectories"
> & {
  workspaceRoots: string[];
  trustedExecutableDirectories: string[];
};
