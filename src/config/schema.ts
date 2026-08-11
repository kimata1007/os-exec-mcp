import { z } from "zod";

export const logLevelSchema = z.enum(["debug", "info", "warn", "error", "silent"]);
export type LogLevel = z.infer<typeof logLevelSchema>;
export const commandModeSchema = z.enum(["allowlist", "denylist"]);
export type CommandMode = z.infer<typeof commandModeSchema>;
export const outputModeSchema = z.enum(["compact", "debug"]);
export type OutputMode = z.infer<typeof outputModeSchema>;

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
    defaultTimeoutMs: z.number().int().min(100).max(600_000).default(120_000),
    maxTimeoutMs: z.number().int().min(100).max(600_000).default(300_000),
    defaultMaxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(256 * 1024),
    absoluteMaxOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
    defaultMaxTotalOutputBytes: z
      .number()
      .int()
      .min(2)
      .max(16 * 1024 * 1024)
      .default(256 * 1024),
    absoluteMaxTotalOutputBytes: z
      .number()
      .int()
      .min(2)
      .max(16 * 1024 * 1024)
      .default(1024 * 1024),
    absoluteMaxSerializedResponseBytes: z
      .number()
      .int()
      .min(1024)
      .max(32 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    defaultOutputMode: outputModeSchema.default("compact"),
    persistTruncatedOutput: z.boolean().default(false),
    persistedOutputTtlMs: z.number().int().min(1000).max(86_400_000).default(300_000),
    persistedOutputMaxBytes: z
      .number()
      .int()
      .min(1024)
      .max(64 * 1024 * 1024)
      .default(4 * 1024 * 1024),
    legacyTools: z.boolean().default(false),
    defaultProgramMaxExecCalls: z.number().int().min(1).max(256).default(32),
    absoluteProgramMaxExecCalls: z.number().int().min(1).max(1024).default(256),
    defaultProgramTimeoutMs: z.number().int().min(100).max(600_000).default(120_000),
    absoluteProgramTimeoutMs: z.number().int().min(100).max(600_000).default(300_000),
    defaultProgramMemoryBytes: z
      .number()
      .int()
      .min(8 * 1024 * 1024)
      .max(1024 * 1024 * 1024)
      .default(64 * 1024 * 1024),
    absoluteProgramMemoryBytes: z
      .number()
      .int()
      .min(8 * 1024 * 1024)
      .max(1024 * 1024 * 1024)
      .default(256 * 1024 * 1024),
    defaultProgramMaxReturnBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024)
      .default(64 * 1024),
    absoluteProgramMaxReturnBytes: z
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
    inheritExecutablePath: z.boolean().default(true),
    commandMode: commandModeSchema.default("denylist"),
    deniedCommands: z
      .array(executableNameSchema)
      .max(256)
      .default(["doas", "pkexec", "runas", "su", "sudo"]),
    commands: z.record(z.string().min(1).max(128), commandPolicySchema).default({}),
    logLevel: logLevelSchema.default("info"),
    readOnly: z.boolean().default(false),
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
    if (value.defaultMaxTotalOutputBytes > value.absoluteMaxTotalOutputBytes) {
      context.addIssue({
        code: "custom",
        message:
          "defaultMaxTotalOutputBytes must not exceed absoluteMaxTotalOutputBytes",
        path: ["defaultMaxTotalOutputBytes"],
      });
    }
    if (value.defaultProgramMaxExecCalls > value.absoluteProgramMaxExecCalls) {
      context.addIssue({
        code: "custom",
        message:
          "defaultProgramMaxExecCalls must not exceed absoluteProgramMaxExecCalls",
        path: ["defaultProgramMaxExecCalls"],
      });
    }
    if (value.defaultProgramTimeoutMs > value.absoluteProgramTimeoutMs) {
      context.addIssue({
        code: "custom",
        message: "defaultProgramTimeoutMs must not exceed absoluteProgramTimeoutMs",
        path: ["defaultProgramTimeoutMs"],
      });
    }
    if (value.defaultProgramMemoryBytes > value.absoluteProgramMemoryBytes) {
      context.addIssue({
        code: "custom",
        message: "defaultProgramMemoryBytes must not exceed absoluteProgramMemoryBytes",
        path: ["defaultProgramMemoryBytes"],
      });
    }
    if (value.defaultProgramMaxReturnBytes > value.absoluteProgramMaxReturnBytes) {
      context.addIssue({
        code: "custom",
        message:
          "defaultProgramMaxReturnBytes must not exceed absoluteProgramMaxReturnBytes",
        path: ["defaultProgramMaxReturnBytes"],
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
