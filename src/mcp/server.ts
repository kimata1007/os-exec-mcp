import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { BatchExecutor } from "../executor/batch-executor.js";
import type { Logger } from "../observability/logger.js";
import { BatchInputError } from "../validation/batch-input.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { batchExecInputSchema, batchExecResultSchema } from "./schema.js";

export type ServerDependencies = {
  executor: BatchExecutor;
  logger: Logger;
};

function publicErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown internal error";
}

export function createOsBatchMcpServer({
  executor,
  logger,
}: ServerDependencies): McpServer {
  const server = new McpServer(
    {
      name: "os-batch-mcp",
      version: "0.1.0",
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  server.registerTool(
    "batch_exec",
    {
      title: "Parallel OS command batch",
      description:
        "Proactively run 1-16 independent, policy-allowed OS commands concurrently, including repository reads and non-conflicting writes to different targets. Supply argv arrays (never shell strings). Results preserve input order and distinguish failures, timeouts, cancellations, policy rejections, skipped commands, and spawn errors. Use continue when partial results remain useful and fail_fast only when later work is invalid after a failure.",
      inputSchema: batchExecInputSchema,
      outputSchema: batchExecResultSchema,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
        readOnlyHint: false,
      },
    },
    async (input, extra) => {
      try {
        const result = await executor.execute(input, extra.signal);
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      } catch (error) {
        if (error instanceof BatchInputError) {
          const payload = {
            error: {
              code: "invalid_input",
              message: error.message,
              issues: error.issues,
            },
          };
          logger.warn("batch_input_rejected", {
            request_id: String(extra.requestId),
            issue_count: error.issues.length,
          });
          return {
            content: [{ type: "text", text: JSON.stringify(payload) }],
            isError: true,
          };
        }

        logger.error("batch_internal_error", {
          request_id: String(extra.requestId),
          error_type: error instanceof Error ? error.name : typeof error,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                error: {
                  code: "internal_error",
                  message: publicErrorMessage(error),
                },
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
