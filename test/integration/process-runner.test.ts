import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProcessRunner } from "../../src/executor/process-runner.js";
import { OutputArtifactStore } from "../../src/executor/output-artifact-store.js";
import { createLogger } from "../../src/observability/logger.js";
import { fixtureCommand } from "../helpers/runner.js";

const runners: ProcessRunner[] = [];
const temporaryDirectories: string[] = [];

function runner(): ProcessRunner {
  const value = new ProcessRunner(createLogger("silent"));
  runners.push(value);
  return value;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!processExists(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

async function waitForFile(filePath: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

afterEach(async () => {
  await Promise.all(runners.splice(0).map(async (value) => await value.shutdown()));
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("ProcessRunner", () => {
  it("captures stdout, stderr, exit status, and duration", async () => {
    const result = await runner().run(
      fixtureCommand("echo", ["echo", "hello", "warning"]),
    );

    expect(result).toMatchObject({
      id: "echo",
      status: "success",
      exit_code: 0,
      stdout: "hello",
      stderr: "warning",
      stdout_bytes: 5,
      stderr_bytes: 7,
    });
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("distinguishes a non-zero exit from a spawn error", async () => {
    const processRunner = runner();
    const failed = await processRunner.run(fixtureCommand("failed", ["exit", "7"]));
    const spawnError = await processRunner.run(
      fixtureCommand("spawn", [], {
        executable: path.join(process.cwd(), "definitely-missing-executable"),
        args: [],
      }),
    );

    expect(failed.status).toBe("failed");
    expect(failed.exit_code).toBe(7);
    expect(spawnError.status).toBe("spawn_error");
    expect(spawnError.exit_code).toBeNull();
  });

  it("drains both streams and truncates each independently", async () => {
    const result = await runner().run(
      fixtureCommand("large", ["large", "131072"], {
        maxOutputBytes: 4096,
      }),
    );

    expect(result.status).toBe("success");
    expect(result.stdout_bytes).toBe(131_072);
    expect(result.stderr_bytes).toBe(131_072);
    expect(Buffer.byteLength(result.stdout)).toBe(4096);
    expect(Buffer.byteLength(result.stderr)).toBe(4096);
    expect(result.stdout_truncated).toBe(true);
    expect(result.stderr_truncated).toBe(true);
  });

  it("optionally persists bounded truncated output behind an opaque resource URI", async () => {
    const store = new OutputArtifactStore(60_000, 4096);
    const processRunner = new ProcessRunner(
      createLogger("silent"),
      undefined,
      store,
      1024,
    );
    runners.push(processRunner);
    const result = await processRunner.run(
      fixtureCommand("persisted", ["large", "512"], { maxOutputBytes: 32 }),
    );

    expect(result.stdout_resource).toMatch(/^os-exec-output:\/\/\//);
    expect(store.get(result.stdout_resource ?? "")).toMatchObject({
      totalBytes: 512,
      retainedBytes: 512,
      truncated: false,
    });
  });

  it("handles invalid UTF-8 output without crashing", async () => {
    const result = await runner().run(fixtureCommand("invalid", ["invalid-utf8"]));

    expect(result.status).toBe("success");
    expect(result.stdout).toContain("a");
    expect(result.stdout_bytes).toBe(3);
  });

  it("times out and terminates the command", async () => {
    const result = await runner().run(
      fixtureCommand("timeout", ["delay", "2000"], { timeoutMs: 150 }),
    );

    expect(result.status).toBe("timeout");
    expect(result.exit_code).toBeNull();
    expect(result.duration_ms).toBeLessThan(1_500);
  });

  it("honors an AbortSignal", async () => {
    const controller = new AbortController();
    const running = runner().run(
      fixtureCommand("cancel", ["delay", "2000"]),
      controller.signal,
    );
    setTimeout(() => {
      controller.abort();
    }, 100);

    await expect(running).resolves.toMatchObject({ status: "cancelled" });
  });

  it("cancels active work during server shutdown", async () => {
    const processRunner = runner();
    const running = processRunner.run(fixtureCommand("shutdown", ["delay", "2000"]));
    setTimeout(() => {
      void processRunner.shutdown();
    }, 100);

    await expect(running).resolves.toMatchObject({ status: "cancelled" });
  });

  it("terminates descendants in the same process tree", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "os-exec-tree-"));
    temporaryDirectories.push(directory);
    const pidFile = path.join(directory, "child.pid");
    const running = runner().run(
      fixtureCommand("tree", ["tree-parent", pidFile], { timeoutMs: 1_500 }),
    );
    const childPid = Number(await waitForFile(pidFile));
    const result = await running;

    expect(result.status).toBe("timeout");
    expect(await waitForProcessExit(childPid)).toBe(true);
  });
});
