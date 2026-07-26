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
    allowedEnvironmentKeys: ["SAFE_VALUE"],
    trustedExecutableDirectories: [path.dirname(process.execPath)],
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
