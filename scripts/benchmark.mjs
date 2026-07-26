import { performance } from "node:perf_hooks";
import path from "node:path";
import process from "node:process";

import { BatchExecutor } from "../dist/executor/batch-executor.js";
import { createLogger } from "../dist/observability/logger.js";

const fixturePath = path.resolve("test/fixtures/child-process.mjs");
const commandCount = 4;
const concurrency = 4;
const commands = Array.from({ length: commandCount }, (_, index) => ({
  id: `delay-${index}`,
  argv: ["node", fixturePath, "delay", "250"],
}));

const policy = {
  workspaceRoots: [process.cwd()],
  maxBatchSize: 16,
  maxConcurrency: 8,
  defaultConcurrency: 4,
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 10_000,
  defaultMaxOutputBytes: 64 * 1024,
  absoluteMaxOutputBytes: 1024 * 1024,
  allowedEnvironmentKeys: [],
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
};

const executor = new BatchExecutor(policy, createLogger("silent"));
try {
  const sequentialStart = performance.now();
  await executor.execute({ commands, concurrency: 1 });
  const sequentialWallTimeMs = Math.round(performance.now() - sequentialStart);

  const parallelStart = performance.now();
  await executor.execute({ commands, concurrency });
  const batchWallTimeMs = Math.round(performance.now() - parallelStart);

  process.stdout.write(`sequential_wall_time_ms=${sequentialWallTimeMs}\n`);
  process.stdout.write(`batch_wall_time_ms=${batchWallTimeMs}\n`);
  process.stdout.write(
    `speedup=${(sequentialWallTimeMs / batchWallTimeMs).toFixed(2)}\n`,
  );
  process.stdout.write(`commands=${commandCount}\n`);
  process.stdout.write(`concurrency=${concurrency}\n`);
} finally {
  await executor.shutdown();
}
