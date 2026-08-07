import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { RuntimePolicy } from "../config/schema.js";
import { BatchExecutor } from "../executor/batch-executor.js";
import { ExecExecutor } from "../executor/exec-executor.js";
import type { OutputArtifactStore } from "../executor/output-artifact-store.js";
import type { ExecResult } from "../executor/types.js";
import { WorkflowExecutor } from "../executor/workflow-executor.js";
import type { Logger } from "../observability/logger.js";
import { ProgramExecutionError } from "../program/errors.js";
import { ProgramExecutor } from "../program/program-executor.js";
import { BatchInputError } from "../validation/batch-input.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import {
  batchExecInputSchema,
  batchExecResultSchema,
  execInputSchema,
  execProgramInputSchema,
  execProgramResultSchema,
  execResultSchema,
  workflowExecInputSchema,
  workflowExecResultSchema,
} from "./schema.js";

export type ServerDependencies = {
  policy: RuntimePolicy;
  execExecutor: ExecExecutor;
  programExecutor: ProgramExecutor;
  logger: Logger;
  executor?: BatchExecutor;
  workflowExecutor?: WorkflowExecutor;
  artifactStore?: OutputArtifactStore;
};

function publicErrorMessage(error: unknown): string {
  return error instanceof Error
    ? `Internal server error (${error.name})`
    : "Unknown internal error";
}

function compactExecResult(result: ExecResult): ExecResult | Record<string, unknown> {
  if (result.output_mode === "debug") {
    return result;
  }
  return {
    request_id: result.request_id,
    output_mode: result.output_mode,
    results: result.results.map((item) => ({
      id: item.id,
      status: item.status,
      ...(item.exit_code === null || item.exit_code === 0
        ? {}
        : { exit_code: item.exit_code }),
      ...(item.stdout.length === 0 ? {} : { stdout: item.stdout }),
      ...(item.stderr.length === 0 ? {} : { stderr: item.stderr }),
      ...(item.stdout_truncated
        ? { stdout_bytes: item.stdout_bytes, stdout_truncated: true }
        : {}),
      ...(item.stderr_truncated
        ? { stderr_bytes: item.stderr_bytes, stderr_truncated: true }
        : {}),
      duration_ms: item.duration_ms,
      ...(item.error === null ? {} : { error: item.error }),
      ...(item.rejection_reason === null
        ? {}
        : { rejection_reason: item.rejection_reason }),
      ...(item.global_queue_wait_ms === 0
        ? {}
        : { global_queue_wait_ms: item.global_queue_wait_ms }),
      ...(item.depends_on.length === 0 ? {} : { depends_on: item.depends_on }),
      ...(item.blocked_by.length === 0 ? {} : { blocked_by: item.blocked_by }),
      ...(item.stdout_resource === undefined
        ? {}
        : { stdout_resource: item.stdout_resource }),
      ...(item.stderr_resource === undefined
        ? {}
        : { stderr_resource: item.stderr_resource }),
    })),
    summary: {
      total: result.summary.total,
      succeeded: result.summary.succeeded,
      ...(result.summary.failed === 0 ? {} : { failed: result.summary.failed }),
      ...(result.summary.timed_out === 0
        ? {}
        : { timed_out: result.summary.timed_out }),
      ...(result.summary.cancelled === 0
        ? {}
        : { cancelled: result.summary.cancelled }),
      ...(result.summary.skipped === 0 ? {} : { skipped: result.summary.skipped }),
      ...(result.summary.rejected === 0 ? {} : { rejected: result.summary.rejected }),
      ...(result.summary.spawn_errors === 0
        ? {}
        : { spawn_errors: result.summary.spawn_errors }),
      wall_time_ms: result.summary.wall_time_ms,
      effective_concurrency: result.summary.effective_concurrency,
      peak_concurrency: result.summary.peak_concurrency,
      global_peak_concurrency: result.summary.global_peak_concurrency,
    },
  };
}

function serializeResult(value: unknown, policy: RuntimePolicy): string {
  const serialized = JSON.stringify(value);
  if (
    Buffer.byteLength(serialized, "utf8") > policy.absoluteMaxSerializedResponseBytes
  ) {
    throw new Error("Serialized tool response exceeds the server response limit");
  }
  return serialized;
}

function errorPayload(error: unknown): {
  error: { code: string; message: string; issues?: string[] };
} {
  if (error instanceof BatchInputError) {
    return {
      error: { code: "invalid_input", message: error.message, issues: error.issues },
    };
  }
  if (error instanceof ProgramExecutionError) {
    return { error: { code: error.code, message: error.message } };
  }
  return {
    error: { code: "internal_error", message: publicErrorMessage(error) },
  };
}

export function createOsExecMcpServer({
  policy,
  execExecutor,
  programExecutor,
  logger,
  executor,
  workflowExecutor,
  artifactStore,
}: ServerDependencies): McpServer {
  const server = new McpServer(
    { name: "os-exec-mcp", version: "0.2.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  if (artifactStore !== undefined) {
    server.registerResource(
      "persisted-command-output",
      new ResourceTemplate("os-exec-output:///{id}", { list: undefined }),
      {
        title: "Temporarily persisted truncated command output",
        description:
          "Private opaque command output retained for a short server-configured TTL.",
        mimeType: "text/plain",
      },
      (uri) => {
        const artifact = artifactStore.get(uri.href);
        if (artifact === undefined) {
          throw new Error("Output resource is unavailable or has expired");
        }
        return {
          contents: [
            {
              uri: artifact.uri,
              mimeType: "text/plain",
              text: artifact.text,
              _meta: {
                total_bytes: artifact.totalBytes,
                retained_bytes: artifact.retainedBytes,
                truncated: artifact.truncated,
                expires_at: new Date(artifact.expiresAt).toISOString(),
              },
            },
          ],
        };
      },
    );
  }

  server.registerTool(
    "exec",
    {
      title: "Validated OS command graph",
      description:
        "Execute independent commands or a dependency DAG in one request. Each step uses an argv array, optional depends_on edges, bounded concurrency, server-owned policy, a global process limit, and a request-wide output budget.",
      inputSchema: execInputSchema,
      outputSchema: execResultSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async (input, extra) => {
      try {
        const full = await execExecutor.execute(input, extra.signal);
        const result = compactExecResult(full);
        const text = serializeResult(result, policy);
        return { content: [{ type: "text", text }], structuredContent: result };
      } catch (error) {
        const payload = errorPayload(error);
        logger.warn("exec_request_failed", {
          request_id: String(extra.requestId),
          error_code: payload.error.code,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "exec_program",
    {
      title: "Sandboxed programmatic command orchestration",
      description:
        "Run a small ECMAScript orchestration program in an isolated QuickJS worker. The only host capabilities are exec(argv, options), parallel(operations, concurrency), lines(value), and finish(value). Every exec is narrowed by allowed_executables and the normal server policy.",
      inputSchema: execProgramInputSchema,
      outputSchema: execProgramResultSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async (input, extra) => {
      try {
        const result = await programExecutor.execute(input, extra.signal);
        const text = serializeResult(result, policy);
        return { content: [{ type: "text", text }], structuredContent: result };
      } catch (error) {
        const payload = errorPayload(error);
        logger.warn("exec_program_request_failed", {
          request_id: String(extra.requestId),
          error_code: payload.error.code,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          isError: true,
        };
      }
    },
  );

  if (policy.legacyTools) {
    if (executor === undefined || workflowExecutor === undefined) {
      throw new Error("Legacy tools are enabled but legacy adapters were not provided");
    }
    server.registerTool(
      "batch_exec",
      {
        title: "Legacy parallel OS command batch",
        description: "Compatibility adapter for exec. Prefer exec with steps.",
        inputSchema: batchExecInputSchema,
        outputSchema: batchExecResultSchema,
      },
      async (input, extra) => {
        try {
          const result = await executor.execute(input, extra.signal);
          return {
            content: [{ type: "text", text: serializeResult(result, policy) }],
            structuredContent: result,
          };
        } catch (error) {
          const payload = errorPayload(error);
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: true,
          };
        }
      },
    );
    server.registerTool(
      "workflow_exec",
      {
        title: "Legacy dependency-aware OS command workflow",
        description: "Compatibility adapter for exec. Prefer exec with steps.",
        inputSchema: workflowExecInputSchema,
        outputSchema: workflowExecResultSchema,
      },
      async (input, extra) => {
        try {
          const result = await workflowExecutor.execute(input, extra.signal);
          return {
            content: [{ type: "text", text: serializeResult(result, policy) }],
            structuredContent: result,
          };
        } catch (error) {
          const payload = errorPayload(error);
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}
