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

import { execProgramResultSchema, execResultSchema } from "../../src/mcp/schema.js";
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

async function connectedClient(
  legacyTools = false,
  persistOutput = false,
): Promise<{
  client: Client;
  stderrLines: string[];
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "os-exec-stdio-"));
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
      ...(persistOutput
        ? {
            persistTruncatedOutput: true,
            persistedOutputTtlMs: 60_000,
            persistedOutputMaxBytes: 4096,
          }
        : {}),
      allowedEnvironmentKeys: [],
      commandMode: "allowlist",
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
      OS_EXEC_POLICY_FILE: policyPath,
      ...(legacyTools ? { OS_EXEC_LEGACY_TOOLS: "true" } : {}),
    },
    stderr: "pipe",
  });
  transports.push(transport);
  const stderrLines: string[] = [];
  const stderr = transport.stderr;
  stderr?.on("data", (chunk: Buffer) => {
    stderrLines.push(chunk.toString("utf8"));
  });

  const client = new Client({ name: "os-exec-test-client", version: "1.0.0" });
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
  it("initializes, lists the unified tools, and returns structured ordered exec results", async () => {
    const { client, stderrLines } = await connectedClient();

    expect(client.getServerVersion()).toMatchObject({
      name: "os-exec-mcp",
      version: "0.2.0",
    });
    expect(client.getInstructions()).toContain("Use exec to submit");

    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(["exec", "exec_program"]);

    const response = await client.callTool({
      name: "exec",
      arguments: {
        steps: [
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
    const result = execResultSchema.parse(response.structuredContent);

    expect(response.isError).not.toBe(true);
    expect(result.results.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(result.results[0]).toMatchObject({
      status: "success",
      stdout: "one",
      stderr: "warning",
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(stderrLines.join("")).toContain('"message":"server_started"');
    expect(stderrLines.join("")).toContain('"command_mode":"allowlist"');
  });

  it("executes a dependency-aware graph through the same MCP tool", async () => {
    const { client } = await connectedClient();
    const response = await client.callTool({
      name: "exec",
      arguments: {
        steps: [
          {
            id: "first",
            argv: ["node", fixturePath, "echo", "one", ""],
          },
          {
            id: "second",
            argv: ["node", fixturePath, "echo", "two", ""],
            depends_on: ["first"],
          },
        ],
        concurrency: 2,
      },
    });
    const result = execResultSchema.parse(response.structuredContent);

    expect(response.isError).not.toBe(true);
    expect(result.results.map(({ status }) => status)).toEqual(["success", "success"]);
    expect(result.results[1]).toMatchObject({
      depends_on: ["first"],
    });
    expect(result.results[1]?.blocked_by).toBeUndefined();
    expect(result.summary.peak_concurrency).toBe(1);
  });

  it("returns a structured tool error for policy-limit input", async () => {
    const { client } = await connectedClient();
    const response = await client.callTool({
      name: "exec",
      arguments: {
        steps: [
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

  it("executes a sandboxed program through MCP", async () => {
    const { client } = await connectedClient();
    const argv = JSON.stringify(["node", fixturePath, "echo", "program", ""]);
    const response = await client.callTool({
      name: "exec_program",
      arguments: {
        source: `const result = await exec(${argv}); finish({ value: result.stdout });`,
        allowed_executables: ["node"],
      },
    });
    const result = execProgramResultSchema.parse(response.structuredContent);

    expect(response.isError).not.toBe(true);
    expect(result.value).toEqual({ value: "program" });
    expect(result.summary.exec_calls).toBe(1);
  });

  it("exposes legacy adapters only when explicitly enabled", async () => {
    const { client } = await connectedClient(true);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual([
      "exec",
      "exec_program",
      "batch_exec",
      "workflow_exec",
    ]);
  });

  it("exposes configured truncated output through an opaque temporary resource", async () => {
    const { client } = await connectedClient(false, true);
    const response = await client.callTool({
      name: "exec",
      arguments: {
        steps: [{ id: "large", argv: ["node", fixturePath, "large", "128"] }],
        output: { max_total_bytes: 32, max_stream_bytes: 32 },
      },
    });
    const result = execResultSchema.parse(response.structuredContent);
    const uri = result.results[0]?.stdout_resource;
    expect(uri).toMatch(/^os-exec-output:\/\/\//);

    const resource = await client.readResource({ uri: uri ?? "" });
    const first = resource.contents[0];
    expect(first).toMatchObject({ uri, mimeType: "text/plain" });
    if (first === undefined || !("text" in first)) {
      throw new Error("Expected a text output resource");
    }
    expect(first.text.length).toBe(128);
  });
});
