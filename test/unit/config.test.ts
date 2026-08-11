import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationError, loadPolicy } from "../../src/config/load.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "os-exec-config-"));
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
  it("loads the single permissive default rooted at the server working directory", async () => {
    const root = await temporaryDirectory();
    const policy = await loadPolicy({}, root);

    expect(policy.workspaceRoots).toEqual([await realpath(root)]);
    expect(policy.readOnly).toBe(false);
    expect(policy.maxConcurrency).toBe(16);
    expect(policy.defaultConcurrency).toBe(8);
    expect(policy.commandMode).toBe("denylist");
    expect(policy.inheritExecutablePath).toBe(true);
    expect(policy.deniedCommands).toEqual(["doas", "pkexec", "runas", "su", "sudo"]);
    expect(policy.deniedCommands).not.toEqual(
      expect.arrayContaining(["docker", "kubectl", "rm", "nohup", "sh"]),
    );
    expect(policy.commands).toEqual({});
    expect(policy.trustedExecutableDirectories).toContain(
      await realpath(path.dirname(process.execPath)),
    );
  });

  it("loads the documented default policy for independent reads and writes", async () => {
    const root = await temporaryDirectory();
    const policy = await loadPolicy(
      {
        OS_EXEC_POLICY_FILE: path.resolve("examples/policy.default.json"),
        OS_EXEC_WORKSPACE_ROOT: root,
      },
      process.cwd(),
    );

    expect(policy.readOnly).toBe(false);
    expect(policy.maxConcurrency).toBe(16);
    expect(policy.commandMode).toBe("denylist");
    expect(policy.inheritExecutablePath).toBe(true);
    expect(policy.deniedCommands).toEqual(["doas", "pkexec", "runas", "su", "sudo"]);
    expect(policy.commands).toEqual({});
    expect(policy.trustedExecutableDirectories).toContain(
      await realpath(path.dirname(process.execPath)),
    );
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

    const policy = await loadPolicy({ OS_EXEC_POLICY_FILE: policyPath }, "/");

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
      loadPolicy({ OS_EXEC_POLICY_FILE: invalidJson }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      loadPolicy({ OS_EXEC_POLICY_FILE: unknownField }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      loadPolicy({ OS_EXEC_POLICY_FILE: missingRoot }, directory),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("supports explicit workspace and log-level environment overrides", async () => {
    const directory = await temporaryDirectory();
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);

    const policy = await loadPolicy(
      {
        OS_EXEC_WORKSPACE_ROOT: workspace,
        OS_EXEC_LOG_LEVEL: "debug",
        OS_EXEC_LEGACY_TOOLS: "true",
      },
      directory,
    );

    expect(policy.workspaceRoots).toEqual([await realpath(workspace)]);
    expect(policy.logLevel).toBe("debug");
    expect(policy.readOnly).toBe(false);
    expect(policy.legacyTools).toBe(true);
  });

  it("accepts legacy OS_BATCH environment aliases during the rename", async () => {
    const directory = await temporaryDirectory();
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);

    const policy = await loadPolicy(
      {
        OS_BATCH_WORKSPACE_ROOT: workspace,
        OS_BATCH_LOG_LEVEL: "debug",
      },
      directory,
    );

    expect(policy.workspaceRoots).toEqual([await realpath(workspace)]);
    expect(policy.logLevel).toBe("debug");
    expect(policy.readOnly).toBe(false);
  });

  it("rejects conflicting new and legacy environment names", async () => {
    const directory = await temporaryDirectory();
    const workspace = path.join(directory, "workspace");
    await mkdir(workspace);

    await expect(
      loadPolicy(
        {
          OS_EXEC_WORKSPACE_ROOT: directory,
          OS_BATCH_WORKSPACE_ROOT: workspace,
        },
        directory,
      ),
    ).rejects.toThrow(
      "OS_EXEC_WORKSPACE_ROOT and legacy OS_BATCH_WORKSPACE_ROOT cannot be set to different values",
    );
  });
});
