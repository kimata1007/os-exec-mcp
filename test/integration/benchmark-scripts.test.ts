import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "os-batch-benchmark-"));
  temporaryDirectories.push(directory);
  return directory;
}

function stderrFromError(error: unknown): string | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("stderr" in error) ||
    typeof error.stderr !== "string"
  ) {
    return undefined;
  }
  return error.stderr;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("benchmark scripts", () => {
  it("summarizes successful and failed end-to-end trials", async () => {
    const directory = await temporaryDirectory();
    const resultsDirectory = path.join(directory, "results");
    const baselineDirectory = path.join(resultsDirectory, "baseline-01");
    const mcpDirectory = path.join(resultsDirectory, "mcp-01");
    await Promise.all([
      mkdir(baselineDirectory, { recursive: true }),
      mkdir(mcpDirectory, { recursive: true }),
    ]);
    const common = {
      schema_version: 1,
      benchmark: "repository-to-github-pages",
      started_at: "2026-07-26T00:00:00.000Z",
      elapsed_ms: 100_000,
    };
    await Promise.all([
      writeFile(
        path.join(baselineDirectory, "result.json"),
        JSON.stringify({
          ...common,
          trial_label: "baseline-01",
          mode: "baseline",
          mode_label: "Baseline",
          success: true,
          phases: {
            pages_configured: { elapsed_ms: 70_000 },
            page_live: { elapsed_ms: 90_000 },
            agent_process_exited: { elapsed_ms: 95_000 },
          },
        }),
        "utf8",
      ),
      writeFile(
        path.join(mcpDirectory, "result.json"),
        JSON.stringify({
          ...common,
          trial_label: "mcp-01",
          mode: "mcp",
          mode_label: "MCP",
          success: false,
          phases: {
            agent_process_exited: { elapsed_ms: 80_000 },
          },
        }),
        "utf8",
      ),
    ]);

    const outputBase = path.join(directory, "summary");
    await execFileAsync(process.execPath, [
      path.resolve("scripts", "e2e-report.mjs"),
      "--results",
      resultsDirectory,
      "--output",
      outputBase,
    ]);

    const summary: unknown = JSON.parse(await readFile(`${outputBase}.json`, "utf8"));
    expect(summary).toMatchObject({
      attempted_trials: 2,
      modes: [
        {
          mode: "baseline",
          attempted: 1,
          succeeded: 1,
          success_rate: 1,
          total_time_ms: { p50: 90_000, p95: 90_000 },
        },
        {
          mode: "mcp",
          attempted: 1,
          succeeded: 0,
          success_rate: 0,
          total_time_ms: { p50: null, p95: null },
        },
      ],
    });
    expect(await readFile(`${outputBase}.svg`, "utf8")).toContain(
      "Repository-to-GitHub-Pages benchmark",
    );
  });

  it("requires an explicit public-repository confirmation", async () => {
    try {
      await execFileAsync(process.execPath, [
        path.resolve("scripts", "e2e-benchmark.mjs"),
        "--config",
        path.resolve("benchmark", "e2e", "config.example.json"),
        "--mode",
        "baseline",
      ]);
      expect.unreachable("The harness accepted an unconfirmed public run");
    } catch (error) {
      expect(stderrFromError(error)).toContain("confirmPublicRepositoryCreation");
    }
  });

  it("runs and reports a local-only trial without GitHub authentication", async () => {
    const directory = await temporaryDirectory();
    const promptPath = path.join(directory, "task.md");
    const configPath = path.join(directory, "config.json");
    const fixture = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      "const name = path.basename(process.cwd());",
      'const runId = name.replace(/^local-test-baseline-/, "");',
      'for (const item of [".git", "src", "docs"]) fs.mkdirSync(item);',
      'fs.writeFileSync("package.json", "{}\\n");',
      'fs.writeFileSync("src/index.ts", "export {};\\n");',
      'fs.writeFileSync("docs/.nojekyll", "");',
      'fs.writeFileSync("docs/index.html", `<meta name="os-batch-benchmark" content="${runId}" />`);',
    ].join("");
    await Promise.all([
      writeFile(promptPath, "Create the local fixture for {{RUN_ID}}.", "utf8"),
      writeFile(
        configPath,
        JSON.stringify({
          publish: false,
          owner: "local",
          repositoryPrefix: "local-test",
          workspaceRoot: "workspaces",
          resultsDirectory: "results",
          promptFile: "task.md",
          pollIntervalMs: 100,
          agentTimeoutMs: 10_000,
          modes: {
            baseline: {
              label: "Baseline",
              command: process.execPath,
              args: ["-e", fixture],
              model: "fixture",
              mcpEnabled: false,
              environment: {},
            },
          },
        }),
        "utf8",
      ),
    ]);

    await execFileAsync(process.execPath, [
      path.resolve("scripts", "e2e-benchmark.mjs"),
      "--config",
      configPath,
      "--mode",
      "baseline",
      "--trial",
      "local-controlled-01",
    ]);

    const resultDirectories = await readdir(path.join(directory, "results"));
    expect(resultDirectories).toHaveLength(1);
    const [resultDirectory] = resultDirectories;
    if (resultDirectory === undefined) {
      throw new Error("Local benchmark did not create a result directory");
    }
    const result: unknown = JSON.parse(
      await readFile(
        path.join(directory, "results", resultDirectory, "result.json"),
        "utf8",
      ),
    );
    expect(result).toMatchObject({
      benchmark: "empty-repository-to-local-application",
      primary_phase: "agent_process_exited",
      success: true,
      repository: { visibility: "local", url: null },
      local_validation: { success: true, missing: [], marker_present: true },
    });

    const outputBase = path.join(directory, "local-summary");
    await execFileAsync(process.execPath, [
      path.resolve("scripts", "e2e-report.mjs"),
      "--results",
      path.join(directory, "results"),
      "--output",
      outputBase,
    ]);
    expect(await readFile(`${outputBase}.svg`, "utf8")).toContain(
      "Empty repository to verified local application",
    );
  });
});
