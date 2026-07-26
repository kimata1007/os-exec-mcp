import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationError, loadPolicy } from "../../src/config/load.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "os-batch-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("policy loading", () => {
  it("loads safe defaults rooted at the server working directory", async () => {
    const root = await temporaryDirectory();
    const policy = await loadPolicy({}, root);

    expect(policy.workspaceRoots).toEqual([await realpath(root)]);
    expect(policy.readOnly).toBe(true);
    expect(policy.commands["git"]?.allowedSubcommands).toContain("status");
  });

  it("loads a strict JSON policy relative to the policy file", async () => {
    const directory = await temporaryDirectory();
    const workspace = path.join(directory, "workspace");
    const bin = path.join(directory, "bin");
    await Promise.all([mkdir(workspace), mkdir(bin)]);
    const policyPath = path.join(directory, "policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        workspaceRoots: ["workspace"],
        trustedExecutableDirectories: ["bin"],
        commands: {},
        readOnly: false,
      }),
      "utf8",
    );

    const policy = await loadPolicy({ OS_BATCH_POLICY_FILE: policyPath }, "/");

    expect(policy.workspaceRoots).toEqual([await realpath(workspace)]);
    expect(policy.trustedExecutableDirectories).toEqual([await realpath(bin)]);
    expect(policy.readOnly).toBe(false);
  });

  it("fails closed for invalid JSON, unknown fields, and missing roots", async () => {
    const directory = await temporaryDirectory();
    const invalidJson = path.join(directory, "invalid.json");
    const unknownField = path.join(directory, "unknown.json");
    const missingRoot = path.join(directory, "missing.json");
    await Promise.all([
      writeFile(invalidJson, "{", "utf8"),
      writeFile(
        unknownField,
        JSON.stringify({ workspaceRoots: ["."], unknown: true }),
        "utf8",
      ),
      writeFile(
        missingRoot,
        JSON.stringify({ workspaceRoots: ["does-not-exist"] }),
        "utf8",
      ),
    ]);

    await expect(
      loadPolicy({ OS_BATCH_POLICY_FILE: invalidJson }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      loadPolicy({ OS_BATCH_POLICY_FILE: unknownField }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      loadPolicy({ OS_BATCH_POLICY_FILE: missingRoot }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("supports explicit workspace, log-level, and read-only environment overrides", async () => {
    const directory = await temporaryDirectory();
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);

    const policy = await loadPolicy(
      {
        OS_BATCH_WORKSPACE_ROOT: workspace,
        OS_BATCH_LOG_LEVEL: "debug",
        OS_BATCH_READ_ONLY: "false",
      },
      directory,
    );

    expect(policy.workspaceRoots).toEqual([await realpath(workspace)]);
    expect(policy.logLevel).toBe("debug");
    expect(policy.readOnly).toBe(false);
  });

  it("rejects malformed boolean overrides", async () => {
    const directory = await temporaryDirectory();

    await expect(
      loadPolicy({ OS_BATCH_READ_ONLY: "maybe" }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
