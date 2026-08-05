#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import process from "node:process";

import { loadPolicy } from "../config/load.js";
import { BatchExecutor } from "../executor/batch-executor.js";
import { WorkflowExecutor } from "../executor/workflow-executor.js";
import { createLogger, type Logger } from "../observability/logger.js";
import { resolveCliEnvironment } from "./options.js";
import { createOsExecMcpServer } from "./server.js";

async function main(): Promise<void> {
  const environment = resolveCliEnvironment(process.argv.slice(2), process.env);
  const policy = await loadPolicy(environment);
  const logger = createLogger(policy.logLevel);
  const executor = new BatchExecutor(policy, logger);
  const workflowExecutor = new WorkflowExecutor(policy, logger);
  const server = createOsExecMcpServer({ executor, workflowExecutor, logger });
  const transport = new StdioServerTransport();
  let shuttingDown = false;

  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("server_stopping", { reason });
    process.exitCode = exitCode;
    await Promise.all([executor.shutdown(), workflowExecutor.shutdown()]);
    await server.close();
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.stdin.once("end", () => {
    void shutdown("stdin_end");
  });
  process.once("uncaughtException", (error) => {
    logger.error("uncaught_exception", {
      error_type: error.name,
      error_message: error.message,
    });
    void shutdown("uncaught_exception", 1);
  });
  process.once("unhandledRejection", (reason) => {
    logger.error("unhandled_rejection", {
      error_type: reason instanceof Error ? reason.name : typeof reason,
      error_message: reason instanceof Error ? reason.message : "Unknown rejection",
    });
    void shutdown("unhandled_rejection", 1);
  });

  await server.connect(transport);
  logger.info("server_started", {
    transport: "stdio",
    workspace_root_count: policy.workspaceRoots.length,
    max_batch_size: policy.maxBatchSize,
    max_concurrency: policy.maxConcurrency,
    read_only: policy.readOnly,
    command_mode: policy.commandMode,
    denied_command_count: policy.deniedCommands.length,
    inherited_executable_path: policy.inheritExecutablePath,
  });
}

main().catch((error: unknown) => {
  const fallbackLogger: Logger = createLogger("error");
  fallbackLogger.error("server_start_failed", {
    error_type: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : "Unknown startup error",
  });
  process.exitCode = 1;
});
