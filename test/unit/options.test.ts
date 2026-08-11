import { describe, expect, it } from "vitest";

import { resolveCliEnvironment } from "../../src/mcp/options.js";

describe("stdio CLI options", () => {
  it("keeps the environment unchanged when no arguments are provided", () => {
    const environment = { PATH: "/usr/bin" };

    expect(resolveCliEnvironment([], environment)).toBe(environment);
  });

  it("rejects every CLI argument, including the removed development flag", () => {
    expect(() => resolveCliEnvironment(["--unknown"], {})).toThrow(
      "Usage: os-exec-mcp",
    );
    expect(() => resolveCliEnvironment(["--development"], {})).toThrow(
      "Usage: os-exec-mcp",
    );
  });
});
