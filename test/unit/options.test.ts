import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveCliEnvironment } from "../../src/mcp/options.js";

describe("stdio CLI options", () => {
  it("keeps the environment unchanged for the safe default mode", () => {
    const environment = { PATH: "/usr/bin" };

    expect(resolveCliEnvironment([], environment)).toBe(environment);
  });

  it("selects the packaged development policy without an absolute user path", () => {
    const environment = resolveCliEnvironment([], {});
    const developmentEnvironment = resolveCliEnvironment(
      ["--development"],
      environment,
      import.meta.url,
      "/workspace",
    );

    expect(developmentEnvironment["OS_EXEC_POLICY_FILE"]).toBe(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "../../examples/policy.development.json",
      ),
    );
    expect(developmentEnvironment["OS_EXEC_WORKSPACE_ROOT"]).toBe("/workspace");
  });

  it("preserves an explicitly configured workspace root", () => {
    const environment = resolveCliEnvironment(
      ["--development"],
      { OS_EXEC_WORKSPACE_ROOT: "/configured/workspace" },
      import.meta.url,
      "/current/workspace",
    );

    expect(environment["OS_EXEC_WORKSPACE_ROOT"]).toBe("/configured/workspace");
  });

  it("rejects unknown arguments and conflicting policy configuration", () => {
    expect(() => resolveCliEnvironment(["--unknown"], {})).toThrow(
      "Usage: os-exec-mcp [--development]",
    );
    expect(() =>
      resolveCliEnvironment(["--development"], {
        OS_EXEC_POLICY_FILE: "/custom/policy.json",
      }),
    ).toThrow("cannot be combined");
  });
});
