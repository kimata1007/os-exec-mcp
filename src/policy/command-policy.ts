import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { CommandPolicy, RuntimePolicy } from "../config/schema.js";
import type { PreparedCommand, ValidatedCommand } from "../executor/types.js";
import { PolicyRejectionError } from "./errors.js";
import { pathIsInside, resolveWorkingDirectory } from "./path-policy.js";

const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

const ALWAYS_DENIED_EXECUTABLES = new Set([
  "bash",
  "cmd",
  "cmd.exe",
  "dash",
  "doas",
  "fish",
  "ksh",
  "pkexec",
  "powershell",
  "powershell.exe",
  "pwsh",
  "runas",
  "sh",
  "su",
  "sudo",
  "zsh",
]);

const ALWAYS_DENIED_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "CDPATH",
  "COMSPEC",
  "ENV",
  "GIT_ASKPASS",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_DIR",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_WORK_TREE",
  "HOME",
  "JDK_JAVA_OPTIONS",
  "JAVA_TOOL_OPTIONS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LUA_CPATH",
  "LUA_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "PERL5OPT",
  "PERL5LIB",
  "PYTHONHOME",
  "PYTHONPATH",
  "RUBYOPT",
  "RUBYLIB",
  "SHELL",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
  "SYSTEMROOT",
  "WINDIR",
  "_JAVA_OPTIONS",
  "__PROTO__",
]);

const ALWAYS_DENIED_ENVIRONMENT_PREFIXES = [
  "AWS_",
  "AZURE_",
  "DYLD_",
  "GIT_",
  "GITHUB_",
  "GOOGLE_",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NPM_CONFIG_",
  "OS_BATCH_",
  "RIPGREP_",
  "SSL_CERT_",
];

const GIT_DIFF_SUBCOMMANDS = new Set(["diff", "log", "show"]);
const GIT_DENIED_ARGUMENTS = new Set([
  "--exec-path",
  "--ext-diff",
  "--help",
  "--no-index",
  "--output",
  "--paginate",
  "--show-signature",
  "--textconv",
  "-c",
]);
const GIT_DENIED_ARGUMENT_PREFIXES = [
  "--config-env=",
  "--exec-path=",
  "--output=",
  "--upload-pack=",
];
const RIPGREP_DENIED_ARGUMENTS = new Set(["--follow", "--hostname-bin", "--pre", "-L"]);
const RIPGREP_DENIED_ARGUMENT_PREFIXES = ["--pre=", "--hostname-bin="];
const FIND_DENIED_ARGUMENTS = new Set([
  "-delete",
  "-exec",
  "-execdir",
  "-fls",
  "-fprint",
  "-fprintf",
  "-ok",
  "-okdir",
]);

function normalizedExecutableName(executable: string): string {
  return process.platform === "win32" ? executable.toLowerCase() : executable;
}

function environmentNameIsDenied(name: string): boolean {
  const uppercaseName = name.toUpperCase();
  return (
    ALWAYS_DENIED_ENVIRONMENT_NAMES.has(uppercaseName) ||
    ALWAYS_DENIED_ENVIRONMENT_PREFIXES.some((prefix) =>
      uppercaseName.startsWith(prefix),
    ) ||
    uppercaseName.endsWith("_TOKEN") ||
    uppercaseName.endsWith("_SECRET") ||
    uppercaseName.endsWith("_PASSWORD")
  );
}

function allowedEnvironmentKey(name: string, allowedKeys: readonly string[]): boolean {
  if (process.platform === "win32") {
    const normalizedName = name.toUpperCase();
    return allowedKeys.some((key) => key.toUpperCase() === normalizedName);
  }
  return allowedKeys.includes(name);
}

function minimalEnvironment(
  policy: RuntimePolicy,
  requested: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: policy.trustedExecutableDirectories.join(path.delimiter),
  };

  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
      const value = process.env[key];
      if (value !== undefined) {
        environment[key] = value;
      }
    }
  } else {
    environment["LANG"] = "C.UTF-8";
    environment["LC_ALL"] = "C.UTF-8";
  }

  for (const [name, value] of Object.entries(requested)) {
    if (environmentNameIsDenied(name)) {
      throw new PolicyRejectionError(
        "environment_key_denied",
        `Environment variable ${name} is always denied`,
      );
    }
    if (!allowedEnvironmentKey(name, policy.allowedEnvironmentKeys)) {
      throw new PolicyRejectionError(
        "environment_key_not_allowed",
        `Environment variable ${name} is not allowed by server policy`,
      );
    }
    environment[name] = value;
  }

  return environment;
}

function executableCandidates(directory: string, executable: string): string[] {
  if (process.platform !== "win32") {
    return [path.join(directory, executable)];
  }

  const extension = path.extname(executable).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return [path.join(directory, executable)];
  }
  return [
    path.join(directory, `${executable}.exe`),
    path.join(directory, `${executable}.com`),
  ];
}

async function validateExecutable(
  candidate: string,
  trustedDirectories: readonly string[] | undefined,
): Promise<string | undefined> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(candidate);
    const metadata = await stat(canonicalPath);
    if (!metadata.isFile()) {
      return undefined;
    }
    await access(
      canonicalPath,
      process.platform === "win32" ? constants.R_OK : constants.R_OK | constants.X_OK,
    );
  } catch {
    return undefined;
  }

  if (
    trustedDirectories !== undefined &&
    !trustedDirectories.some((directory) => pathIsInside(directory, canonicalPath))
  ) {
    return undefined;
  }
  return canonicalPath;
}

async function resolveExecutable(
  executable: string,
  rule: CommandPolicy,
  policy: RuntimePolicy,
): Promise<string> {
  if (rule.path !== undefined) {
    if (!path.isAbsolute(rule.path)) {
      throw new PolicyRejectionError(
        "invalid_executable_path",
        "A command policy executable path must be absolute",
      );
    }
    const canonicalPath = await validateExecutable(rule.path, undefined);
    if (canonicalPath === undefined) {
      throw new PolicyRejectionError(
        "executable_not_found",
        "The configured executable path does not resolve to an executable file",
      );
    }
    return canonicalPath;
  }

  for (const directory of policy.trustedExecutableDirectories) {
    for (const candidate of executableCandidates(directory, executable)) {
      const canonicalPath = await validateExecutable(
        candidate,
        policy.trustedExecutableDirectories,
      );
      if (canonicalPath !== undefined) {
        return canonicalPath;
      }
    }
  }

  throw new PolicyRejectionError(
    "executable_not_found",
    "The allowed executable was not found in a trusted executable directory",
  );
}

function rejectArgument(
  argument: string,
  deniedArguments: ReadonlySet<string>,
  deniedPrefixes: readonly string[],
  executable: string,
): void {
  if (
    deniedArguments.has(argument) ||
    deniedPrefixes.some((prefix) => argument.startsWith(prefix))
  ) {
    throw new PolicyRejectionError(
      "argument_denied",
      `${executable} argument ${argument} is denied by the built-in safety policy`,
    );
  }
}

function rejectPathEscape(argument: string, executable: string): void {
  if (
    path.isAbsolute(argument) ||
    path.win32.isAbsolute(argument) ||
    /(?:^|[/\\])\.\.(?:[/\\]|$)/.test(argument)
  ) {
    throw new PolicyRejectionError(
      "argument_path_escape",
      `${executable} arguments must not contain absolute paths or parent-directory traversal`,
    );
  }
}

function hardenGitArguments(clientArguments: readonly string[]): string[] {
  const subcommand = clientArguments[0];
  if (subcommand === undefined) {
    return [];
  }

  for (const argument of clientArguments.slice(1)) {
    rejectArgument(argument, GIT_DENIED_ARGUMENTS, GIT_DENIED_ARGUMENT_PREFIXES, "git");
    rejectPathEscape(argument, "git");
    if (argument.includes("%G")) {
      throw new PolicyRejectionError(
        "argument_denied",
        "git signature format placeholders are denied because they can invoke a configured verifier",
      );
    }
  }

  const hardenedSubcommandArguments = [
    subcommand,
    ...(GIT_DIFF_SUBCOMMANDS.has(subcommand) ? ["--no-ext-diff", "--no-textconv"] : []),
    ...clientArguments.slice(1),
  ];

  return [
    "--no-pager",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    ...hardenedSubcommandArguments,
  ];
}

function hardenedArguments(
  executable: string,
  clientArguments: readonly string[],
): string[] {
  if (executable === "git") {
    return hardenGitArguments(clientArguments);
  }
  if (executable === "rg") {
    clientArguments.forEach((argument) => {
      rejectArgument(
        argument,
        RIPGREP_DENIED_ARGUMENTS,
        RIPGREP_DENIED_ARGUMENT_PREFIXES,
        "rg",
      );
      rejectPathEscape(argument, "rg");
    });
  }
  if (executable === "find") {
    clientArguments.forEach((argument) => {
      rejectArgument(argument, FIND_DENIED_ARGUMENTS, [], "find");
      rejectPathEscape(argument, "find");
    });
  }
  return [...clientArguments];
}

function commandRule(
  executable: string,
  policy: RuntimePolicy,
): CommandPolicy | undefined {
  if (process.platform !== "win32") {
    return policy.commands[executable];
  }
  const normalized = executable.toLowerCase();
  return Object.entries(policy.commands).find(
    ([name]) => name.toLowerCase() === normalized,
  )?.[1];
}

export class CommandPolicyEvaluator {
  public constructor(private readonly policy: RuntimePolicy) {}

  public async prepare(
    command: ValidatedCommand,
    maxOutputBytes: number,
  ): Promise<PreparedCommand> {
    const executable = command.argv[0];
    if (executable === undefined || !EXECUTABLE_NAME_PATTERN.test(executable)) {
      throw new PolicyRejectionError(
        "invalid_executable_name",
        "argv[0] must be a simple executable name without path separators",
      );
    }

    const normalizedName = normalizedExecutableName(executable);
    if (ALWAYS_DENIED_EXECUTABLES.has(normalizedName)) {
      throw new PolicyRejectionError(
        "privileged_or_shell_command_denied",
        "Shells and privilege-elevation commands are always denied",
      );
    }

    const rule = commandRule(executable, this.policy);
    if (rule?.allowed !== true) {
      throw new PolicyRejectionError(
        "command_not_allowed",
        `Executable ${executable} is not allowed by server policy`,
      );
    }
    if (this.policy.readOnly && !rule.readOnly) {
      throw new PolicyRejectionError(
        "read_only_policy",
        `Executable ${executable} is not classified as read-only`,
      );
    }

    const clientArguments = command.argv.slice(1);
    if (rule.allowedSubcommands !== undefined) {
      const subcommand = clientArguments[0];
      if (subcommand === undefined || !rule.allowedSubcommands.includes(subcommand)) {
        throw new PolicyRejectionError(
          "subcommand_not_allowed",
          `Subcommand ${subcommand ?? "(missing)"} is not allowed for ${executable}`,
        );
      }
    }

    const cwd = await resolveWorkingDirectory(command.cwd, this.policy);
    const resolvedExecutable = await resolveExecutable(executable, rule, this.policy);
    const environment = minimalEnvironment(this.policy, command.env);

    if (normalizedName === "git") {
      environment["GIT_CONFIG_GLOBAL"] =
        process.platform === "win32" ? "NUL" : "/dev/null";
      environment["GIT_CONFIG_NOSYSTEM"] = "1";
      environment["GIT_OPTIONAL_LOCKS"] = "0";
      environment["GIT_TERMINAL_PROMPT"] = "0";
    }

    return {
      id: command.id,
      executable: resolvedExecutable,
      args: hardenedArguments(normalizedName, clientArguments),
      cwd,
      timeoutMs: command.timeoutMs,
      env: environment,
      maxOutputBytes,
    };
  }
}
