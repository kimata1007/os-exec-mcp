import type { ConfigurationEnvironment } from "../config/load.js";

export function resolveCliEnvironment(
  arguments_: readonly string[],
  environment: ConfigurationEnvironment,
): ConfigurationEnvironment {
  if (arguments_.length === 0) {
    return environment;
  }

  throw new Error("Unknown argument. Usage: os-exec-mcp");
}
