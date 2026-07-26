import path from "node:path";

import type { PreparedCommand } from "../../src/executor/types.js";

export const fixturePath = path.resolve("test/fixtures/child-process.mjs");

export function fixtureCommand(
  id: string,
  arguments_: string[],
  overrides: Partial<PreparedCommand> = {},
): PreparedCommand {
  return {
    id,
    executable: process.execPath,
    args: [fixturePath, ...arguments_],
    cwd: process.cwd(),
    timeoutMs: 2_000,
    env: {},
    maxOutputBytes: 64 * 1024,
    ...overrides,
  };
}
