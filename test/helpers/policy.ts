import { realpathSync } from "node:fs";
import path from "node:path";

import type { RuntimePolicy } from "../../src/config/schema.js";

export function testPolicy(
  workspaceRoot: string,
  overrides: Partial<RuntimePolicy> = {},
): RuntimePolicy {
  return {
    workspaceRoots: [realpathSync(workspaceRoot)],
    maxBatchSize: 16,
    maxConcurrency: 8,
    defaultConcurrency: 4,
    defaultTimeoutMs: 2_000,
    maxTimeoutMs: 10_000,
    defaultMaxOutputBytes: 64 * 1024,
    absoluteMaxOutputBytes: 1024 * 1024,
    defaultMaxTotalOutputBytes: 64 * 1024,
    absoluteMaxTotalOutputBytes: 1024 * 1024,
    absoluteMaxSerializedResponseBytes: 2 * 1024 * 1024,
    defaultOutputMode: "compact",
    persistTruncatedOutput: false,
    persistedOutputTtlMs: 300_000,
    persistedOutputMaxBytes: 4 * 1024 * 1024,
    legacyTools: false,
    defaultProgramMaxExecCalls: 32,
    absoluteProgramMaxExecCalls: 256,
    defaultProgramTimeoutMs: 10_000,
    absoluteProgramTimeoutMs: 60_000,
    defaultProgramMemoryBytes: 64 * 1024 * 1024,
    absoluteProgramMemoryBytes: 256 * 1024 * 1024,
    defaultProgramMaxReturnBytes: 64 * 1024,
    absoluteProgramMaxReturnBytes: 1024 * 1024,
    allowedEnvironmentKeys: ["SAFE_VALUE"],
    trustedExecutableDirectories: [path.dirname(process.execPath)],
    inheritExecutablePath: false,
    commandMode: "allowlist",
    deniedCommands: [],
    commands: {
      node: {
        allowed: true,
        path: process.execPath,
        readOnly: true,
      },
    },
    logLevel: "silent",
    readOnly: true,
    ...overrides,
  };
}
