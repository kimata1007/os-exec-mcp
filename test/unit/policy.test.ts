import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CommandPolicyEvaluator } from "../../src/policy/command-policy.js";
import type { ValidatedCommand } from "../../src/executor/types.js";
import { testPolicy } from "../helpers/policy.js";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "os-batch-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}

function command(
  argv: string[],
  overrides: Partial<ValidatedCommand> = {},
): ValidatedCommand {
  return {
    id: "command",
    argv,
    timeoutMs: 1_000,
    env: {},
    ...overrides,
  };
}

async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({
    code,
  });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

describe("command and path policy", () => {
  it("allows a configured executable", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(testPolicy(root));

    const prepared = await evaluator.prepare(command(["node", "--version"]), 1024);

    expect(prepared.executable).toBe(process.execPath);
    expect(prepared.cwd).toBe(await realpath(root));
    expect(prepared.args).toEqual(["--version"]);
  });

  it("rejects a command outside the allowlist", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(testPolicy(root));

    await expectRejection(
      evaluator.prepare(command(["not-allowed"]), 1024),
      "command_not_allowed",
    );
  });

  it("allows only configured git subcommands and injects safe git options", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(
      testPolicy(root, {
        commands: {
          git: {
            allowed: true,
            path: process.execPath,
            readOnly: true,
            allowedSubcommands: ["status"],
          },
        },
      }),
    );

    const prepared = await evaluator.prepare(
      command(["git", "status", "--short"]),
      1024,
    );
    expect(prepared.args).toContain("--no-pager");
    expect(prepared.args).toContain("core.fsmonitor=false");
    expect(prepared.args).toContain("status");

    await expectRejection(
      evaluator.prepare(command(["git", "reset", "--hard"]), 1024),
      "subcommand_not_allowed",
    );
  });

  it("rejects dangerous git, ripgrep, and find execution options", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(
      testPolicy(root, {
        commands: {
          git: {
            allowed: true,
            path: process.execPath,
            readOnly: true,
            allowedSubcommands: ["diff"],
          },
          rg: { allowed: true, path: process.execPath, readOnly: true },
          find: { allowed: true, path: process.execPath, readOnly: true },
        },
      }),
    );

    await expectRejection(
      evaluator.prepare(command(["git", "diff", "--ext-diff"]), 1024),
      "argument_denied",
    );
    await expectRejection(
      evaluator.prepare(command(["git", "diff", "--output=report.txt"]), 1024),
      "argument_denied",
    );
    await expectRejection(
      evaluator.prepare(command(["rg", "--pre=sh bad"]), 1024),
      "argument_denied",
    );
    await expectRejection(
      evaluator.prepare(command(["rg", "pattern", "/etc/passwd"]), 1024),
      "argument_path_escape",
    );
    await expectRejection(
      evaluator.prepare(command(["find", ".", "-exec", "bad", ";"]), 1024),
      "argument_denied",
    );
  });

  it("enforces read-only classification", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(
      testPolicy(root, {
        commands: {
          node: { allowed: true, path: process.execPath, readOnly: false },
        },
      }),
    );

    await expectRejection(
      evaluator.prepare(command(["node"]), 1024),
      "read_only_policy",
    );
  });

  it("rejects absolute, parent, and symlink escapes outside the workspace", async () => {
    const parent = await temporaryDirectory();
    const root = path.join(parent, "root");
    const outside = path.join(parent, "outside");
    await Promise.all([
      import("node:fs/promises").then(async ({ mkdir }) => {
        await mkdir(root);
      }),
      import("node:fs/promises").then(async ({ mkdir }) => {
        await mkdir(outside);
      }),
    ]);
    const link = path.join(root, "escape");
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    const evaluator = new CommandPolicyEvaluator(testPolicy(root));

    await expectRejection(
      evaluator.prepare(command(["node"], { cwd: outside }), 1024),
      "cwd_outside_workspace",
    );
    await expectRejection(
      evaluator.prepare(command(["node"], { cwd: "../outside" }), 1024),
      "cwd_outside_workspace",
    );
    await expectRejection(
      evaluator.prepare(command(["node"], { cwd: "escape" }), 1024),
      "cwd_outside_workspace",
    );
  });

  it("rejects files and missing directories as cwd", async () => {
    const root = await temporaryDirectory();
    await writeFile(path.join(root, "file"), "x", "utf8");
    const evaluator = new CommandPolicyEvaluator(testPolicy(root));

    await expectRejection(
      evaluator.prepare(command(["node"], { cwd: "file" }), 1024),
      "cwd_not_directory",
    );
    await expectRejection(
      evaluator.prepare(command(["node"], { cwd: "missing" }), 1024),
      "cwd_not_found",
    );
  });

  it("permits only explicitly allowed, non-sensitive environment keys", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(testPolicy(root));

    const prepared = await evaluator.prepare(
      command(["node"], { env: { SAFE_VALUE: "yes" } }),
      1024,
    );
    expect(prepared.env["SAFE_VALUE"]).toBe("yes");
    expect(prepared.env["PATH"]).toBeDefined();

    await expectRejection(
      evaluator.prepare(command(["node"], { env: { OTHER: "no" } }), 1024),
      "environment_key_not_allowed",
    );
    await expectRejection(
      evaluator.prepare(command(["node"], { env: { PATH: "/tmp" } }), 1024),
      "environment_key_denied",
    );
  });

  it("always rejects shells and executable paths supplied by clients", async () => {
    const root = await temporaryDirectory();
    const evaluator = new CommandPolicyEvaluator(
      testPolicy(root, {
        commands: {
          sh: { allowed: true, path: process.execPath, readOnly: true },
          "/bin/sh": { allowed: true, path: process.execPath, readOnly: true },
        },
      }),
    );

    await expectRejection(
      evaluator.prepare(command(["sh", "-c", "echo bad"]), 1024),
      "privileged_or_shell_command_denied",
    );
    await expectRejection(
      evaluator.prepare(command(["/bin/sh", "-c", "echo bad"]), 1024),
      "invalid_executable_name",
    );
  });

  it("does not follow an executable symlink outside a trusted directory", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await temporaryDirectory();
    const bin = path.join(root, "bin");
    await import("node:fs/promises").then(async ({ mkdir }) => {
      await mkdir(bin);
    });
    const fake = path.join(bin, "fake");
    await symlink(process.execPath, fake);
    await chmod(bin, 0o755);
    const evaluator = new CommandPolicyEvaluator(
      testPolicy(root, {
        trustedExecutableDirectories: [bin],
        commands: { fake: { allowed: true, readOnly: true } },
      }),
    );

    await expectRejection(
      evaluator.prepare(command(["fake"]), 1024),
      "executable_not_found",
    );
  });
});
