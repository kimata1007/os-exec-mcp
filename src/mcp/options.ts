import { fileURLToPath } from "node:url";
import process from "node:process";

import type { ConfigurationEnvironment } from "../config/load.js";

const DEVELOPMENT_FLAG = "--development";

export function resolveCliEnvironment(
  arguments_: readonly string[],
  environment: ConfigurationEnvironment,
  moduleUrl = import.meta.url,
  workingDirectory = process.cwd(),
): ConfigurationEnvironment {
  if (arguments_.length === 0) {
    return environment;
  }

  if (arguments_.length !== 1 || arguments_[0] !== DEVELOPMENT_FLAG) {
    throw new Error(`Unknown argument. Usage: os-exec-mcp [${DEVELOPMENT_FLAG}]`);
  }

  if (
    environment["OS_EXEC_POLICY_FILE"] !== undefined ||
    environment["OS_BATCH_POLICY_FILE"] !== undefined
  ) {
    throw new Error(
      `${DEVELOPMENT_FLAG} cannot be combined with OS_EXEC_POLICY_FILE or OS_BATCH_POLICY_FILE`,
    );
  }

  return {
    ...environment,
    OS_EXEC_POLICY_FILE: fileURLToPath(
      new URL("../../examples/policy.development.json", moduleUrl),
    ),
    ...(environment["OS_EXEC_WORKSPACE_ROOT"] === undefined &&
    environment["OS_BATCH_WORKSPACE_ROOT"] === undefined
      ? { OS_EXEC_WORKSPACE_ROOT: workingDirectory }
      : {}),
  };
}
