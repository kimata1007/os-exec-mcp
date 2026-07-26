import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { batchExecResultSchema } from "../../src/mcp/schema.js";
import { fixturePath } from "../helpers/runner.js";

const clients: Client[] = [];
const transports: StdioClientTransport[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    clients.splice(0).map(async (client) => await client.close()),
  );
  await Promise.allSettled(
    transports.splice(0).map(async (transport) => await transport.close()),
  );
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

async function connectedClient(): Promise<{
  client: Client;
  stderrLines: string[];
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "os-batch-stdio-"));
  temporaryDirectories.push(directory);
  const workspace = path.join(directory, "workspace");
  const bin = path.join(directory, "bin");
  await Promise.all([mkdir(workspace), mkdir(bin)]);
  const policyPath = path.join(directory, "policy.json");
  await writeFile(
    policyPath,
    JSON.stringify({
      workspaceRoots: [workspace],
      trustedExecutableDirectories: [path.dirname(process.execPath)],
      maxBatchSize: 4,
      maxConcurrency: 3,
      defaultConcurrency: 2,
      defaultTimeoutMs: 2_000,
      maxTimeoutMs: 5_000,
      defaultMaxOutputBytes: 4096,
      absoluteMaxOutputBytes: 8192,
      allowedEnvironmentKeys: [],
      commands: {
        node: {
          allowed: true,
          path: process.execPath,
          readOnly: true,
        },
      },
      logLevel: "debug",
      readOnly: true,
    }),
    "utf8",
  );

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/mcp/stdio.js")],
    cwd: process.cwd(),
    env: {
      ...getDefaultEnvironment(),
      OS_BATCH_POLICY_FILE: policyPath,
    },
    stderr: "pipe",
  });
  transports.push(transport);
  const stderrLines: string[] = [];
  const stderr = transport.stderr;
  stderr?.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk.toString("utf8"));
  });

  const client = new Client({ name: "os-batch-test-client", version: "1.0.0" });
  clients.push(client);
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`stdio server failed:\n${stderrLines.join("")}`, {
      cause: error,
    });
  }
  return { client, stderrLines };
}

describe("stdio MCP protocol", () => {
  it("initializes, lists batch_exec, and returns structured ordered results", async () => {
    const { client, stderrLines } = await connectedClient();

    expect(client.getServerVersion()).toMatchObject({
      name: "os-batch-mcp",
      version: "0.1.0",
    });
    expect(client.getInstructions()).toContain("Batch only independent operations");

    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(1);
    expect(listed.tools[0]?.name).toBe("batch_exec");

    const response = await client.callTool({
      name: "batch_exec",
      arguments: {
        commands: [
          {
            id: "first",
            argv: ["node", fixturePath, "echo", "one", "warning"],
          },
          {
            id: "second",
            argv: ["node", fixturePath, "echo", "two", ""],
          },
        ],
        concurrency: 2,
        failure_mode: "continue",
      },
    });
    const result = batchExecResultSchema.parse(response.structuredContent);

    expect(response.isError).not.toBe(true);
    expect(result.results.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(result.results[0]).toMatchObject({
      status: "success",
      stdout: "one",
      stderr: "warning",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stderrLines.join("")).toContain('"message":"server_started"');
  });

  it("returns a structured tool error for policy-limit input", async () => {
    const { client } = await connectedClient();
    const response = await client.callTool({
      name: "batch_exec",
      arguments: {
        commands: [
          {
            id: "too-long",
            argv: ["node", fixturePath, "echo"],
            timeout_ms: 5_001,
          },
        ],
      },
    });

    expect(response.isError).toBe(true);
    const errorResponse = z
      .object({
        content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
        isError: z.literal(true),
      })
      .parse(response);
    expect(JSON.parse(errorResponse.content[0]?.text ?? "{}")).toMatchObject({
      error: { code: "invalid_input" },
    });
  });
});
