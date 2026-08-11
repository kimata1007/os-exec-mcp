import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { z } from "zod";

import {
  type PolicyFile,
  type RuntimePolicy,
  logLevelSchema,
  policyFileSchema,
} from "./schema.js";

const DEFAULT_POLICY: PolicyFile = policyFileSchema.parse({});

export type ConfigurationEnvironment = Readonly<Record<string, string | undefined>>;

export class ConfigurationError extends Error {
  public override readonly name = "ConfigurationError";
}

function parseBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "true" || value === "1") {
    return true;
  }
  if (value === "false" || value === "0") {
    return false;
  }
  throw new ConfigurationError(`${name} must be true, false, 1, or 0`);
}

function renamedEnvironmentValue(
  environment: ConfigurationEnvironment,
  name: string,
  legacyName: string,
): string | undefined {
  const value = environment[name];
  const legacyValue = environment[legacyName];
  if (value !== undefined && legacyValue !== undefined && value !== legacyValue) {
    throw new ConfigurationError(
      `${name} and legacy ${legacyName} cannot be set to different values`,
    );
  }
  return value ?? legacyValue;
}

function defaultTrustedDirectories(): string[] {
  if (process.platform === "win32") {
    const systemRoot = process.env["SystemRoot"] ?? process.env["WINDIR"];
    return [
      path.dirname(process.execPath),
      ...(systemRoot === undefined ? [] : [path.join(systemRoot, "System32")]),
    ];
  }

  return [path.dirname(process.execPath), "/usr/bin", "/bin"];
}

function inheritedPathDirectories(environment: ConfigurationEnvironment): string[] {
  const pathValue =
    environment["PATH"] ?? environment["Path"] ?? process.env["PATH"] ?? "";
  return pathValue
    .split(path.delimiter)
    .filter((directory) => directory.length > 0 && path.isAbsolute(directory));
}

async function canonicalDirectory(
  configuredPath: string,
  baseDirectory: string,
  label: string,
): Promise<string> {
  const absolutePath = path.resolve(baseDirectory, configuredPath);
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(absolutePath);
  } catch (error) {
    throw new ConfigurationError(
      `${label} does not exist or cannot be resolved: ${absolutePath} (${errorMessage(error)})`,
    );
  }

  const metadata = await stat(canonicalPath);
  if (!metadata.isDirectory()) {
    throw new ConfigurationError(`${label} is not a directory: ${absolutePath}`);
  }
  return canonicalPath;
}

async function canonicalExecutableDirectory(
  configuredPath: string,
  baseDirectory: string,
): Promise<string> {
  const canonicalPath = await canonicalDirectory(
    configuredPath,
    baseDirectory,
    "trusted executable directory",
  );
  await access(canonicalPath, constants.R_OK | constants.X_OK);
  return canonicalPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readPolicyFile(
  policyFilePath: string,
  baseDirectory: string,
): Promise<{ policy: PolicyFile; policyDirectory: string }> {
  const absolutePath = path.resolve(baseDirectory, policyFilePath);
  let contents: string;
  try {
    contents = await readFile(absolutePath, "utf8");
  } catch (error) {
    throw new ConfigurationError(
      `Cannot read policy file ${absolutePath}: ${errorMessage(error)}`,
    );
  }

  let untrusted: unknown;
  try {
    untrusted = JSON.parse(contents);
  } catch (error) {
    throw new ConfigurationError(
      `Policy file is not valid JSON: ${errorMessage(error)}`,
    );
  }

  const parsed = policyFileSchema.safeParse(untrusted);
  if (!parsed.success) {
    throw new ConfigurationError(
      `Policy file validation failed: ${z.prettifyError(parsed.error)}`,
    );
  }

  return {
    policy: parsed.data,
    policyDirectory: path.dirname(absolutePath),
  };
}

export async function loadPolicy(
  environment: ConfigurationEnvironment = process.env,
  workingDirectory = process.cwd(),
): Promise<RuntimePolicy> {
  const policyFilePath = renamedEnvironmentValue(
    environment,
    "OS_EXEC_POLICY_FILE",
    "OS_BATCH_POLICY_FILE",
  );
  const loaded =
    policyFilePath === undefined
      ? { policy: DEFAULT_POLICY, policyDirectory: workingDirectory }
      : await readPolicyFile(policyFilePath, workingDirectory);

  const workspaceOverride = renamedEnvironmentValue(
    environment,
    "OS_EXEC_WORKSPACE_ROOT",
    "OS_BATCH_WORKSPACE_ROOT",
  );
  const configuredRoots =
    workspaceOverride === undefined
      ? loaded.policy.workspaceRoots
      : [workspaceOverride];
  const rootBase =
    workspaceOverride === undefined ? loaded.policyDirectory : workingDirectory;

  const workspaceRoots = await Promise.all(
    configuredRoots.map((root) => canonicalDirectory(root, rootBase, "workspace root")),
  );

  const explicitlyConfiguredTrustedDirectories =
    loaded.policy.trustedExecutableDirectories;
  const configuredTrustedDirectories =
    explicitlyConfiguredTrustedDirectories ??
    (loaded.policy.inheritExecutablePath
      ? [...inheritedPathDirectories(environment), ...defaultTrustedDirectories()]
      : defaultTrustedDirectories());
  const trustedBase =
    explicitlyConfiguredTrustedDirectories === undefined
      ? workingDirectory
      : loaded.policyDirectory;

  const trustedExecutableDirectories: string[] = [];
  for (const directory of configuredTrustedDirectories) {
    try {
      trustedExecutableDirectories.push(
        await canonicalExecutableDirectory(directory, trustedBase),
      );
    } catch (error) {
      if (explicitlyConfiguredTrustedDirectories !== undefined) {
        throw error;
      }
    }
  }

  if (trustedExecutableDirectories.length === 0) {
    throw new ConfigurationError("No trusted executable directory is available");
  }

  const logLevelOverride = renamedEnvironmentValue(
    environment,
    "OS_EXEC_LOG_LEVEL",
    "OS_BATCH_LOG_LEVEL",
  );
  const parsedLogLevel =
    logLevelOverride === undefined
      ? loaded.policy.logLevel
      : logLevelSchema.parse(logLevelOverride);
  const legacyToolsOverride = parseBoolean(
    "OS_EXEC_LEGACY_TOOLS",
    environment["OS_EXEC_LEGACY_TOOLS"],
  );

  return {
    ...loaded.policy,
    workspaceRoots: [...new Set(workspaceRoots)],
    trustedExecutableDirectories: [...new Set(trustedExecutableDirectories)],
    logLevel: parsedLogLevel,
    legacyTools: legacyToolsOverride ?? loaded.policy.legacyTools,
  };
}
