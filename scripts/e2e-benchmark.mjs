import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";

const NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PLACEHOLDER_PATTERN = /\{\{([A-Z_]+)\}\}/g;
const OUTPUT_LIMIT_BYTES = 1024 * 1024;

function parseArguments(arguments_) {
  const parsed = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--config" || argument === "--mode" || argument === "--trial") {
      const value = arguments_[index + 1];
      if (value === undefined) {
        throw new Error(`${argument} requires a value`);
      }
      parsed[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (parsed.config === undefined || parsed.mode === undefined) {
    throw new Error(
      "Usage: node scripts/e2e-benchmark.mjs --config <file> --mode <name> [--trial <label>]",
    );
  }
  return parsed;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, label, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

function requireStringArray(value, label) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value;
}

function validateConfiguration(untrusted, modeName, configPath) {
  if (typeof untrusted !== "object" || untrusted === null || Array.isArray(untrusted)) {
    throw new Error("Configuration must be a JSON object");
  }
  if (untrusted.confirmPublicRepositoryCreation !== true) {
    throw new Error(
      "Set confirmPublicRepositoryCreation to true after reviewing the public-repository side effects",
    );
  }
  const owner = requireString(untrusted.owner, "owner");
  if (!NAME_PATTERN.test(owner.toLowerCase())) {
    throw new Error("owner must be a safe GitHub account name");
  }
  const repositoryPrefix = requireString(
    untrusted.repositoryPrefix,
    "repositoryPrefix",
  );
  if (!NAME_PATTERN.test(repositoryPrefix)) {
    throw new Error("repositoryPrefix must be a safe lowercase GitHub name prefix");
  }
  if (!MODE_PATTERN.test(modeName)) {
    throw new Error(
      "mode must contain only lowercase letters, digits, underscores, or dashes",
    );
  }
  const modes = untrusted.modes;
  if (typeof modes !== "object" || modes === null || Array.isArray(modes)) {
    throw new Error("modes must be an object");
  }
  const mode = modes[modeName];
  if (typeof mode !== "object" || mode === null || Array.isArray(mode)) {
    throw new Error(`Unknown benchmark mode: ${modeName}`);
  }
  const environment = mode.environment ?? {};
  if (
    typeof environment !== "object" ||
    environment === null ||
    Array.isArray(environment) ||
    !Object.values(environment).every((value) => typeof value === "string")
  ) {
    throw new Error(`modes.${modeName}.environment must contain only string values`);
  }
  const configDirectory = path.dirname(configPath);
  return {
    owner,
    repositoryPrefix,
    workspaceRoot: path.resolve(
      configDirectory,
      requireString(untrusted.workspaceRoot, "workspaceRoot"),
    ),
    resultsDirectory: path.resolve(
      configDirectory,
      requireString(untrusted.resultsDirectory, "resultsDirectory"),
    ),
    pollIntervalMs: requirePositiveInteger(
      untrusted.pollIntervalMs ?? 5_000,
      "pollIntervalMs",
      60_000,
    ),
    agentTimeoutMs: requirePositiveInteger(
      untrusted.agentTimeoutMs ?? 1_800_000,
      "agentTimeoutMs",
      7_200_000,
    ),
    deploymentTimeoutMs: requirePositiveInteger(
      untrusted.deploymentTimeoutMs ?? 600_000,
      "deploymentTimeoutMs",
      1_800_000,
    ),
    mode: {
      name: modeName,
      label: requireString(mode.label ?? modeName, `modes.${modeName}.label`),
      command: requireString(mode.command, `modes.${modeName}.command`),
      args: requireStringArray(mode.args ?? [], `modes.${modeName}.args`),
      model: requireString(mode.model, `modes.${modeName}.model`),
      mcpEnabled: mode.mcpEnabled === true,
      environment,
    },
  };
}

function timestampName() {
  const timestamp = new Date()
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "z")
    .toLowerCase();
  const random = Math.random().toString(36).slice(2, 7);
  return `${timestamp}-${random}`;
}

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function executableOnPath(name) {
  const pathValue = process.env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.COM").split(";")
      : [""];
  for (const directory of pathValue.split(path.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, `${name}${extension}`);
      try {
        await access(
          candidate,
          process.platform === "win32"
            ? constants.R_OK
            : constants.R_OK | constants.X_OK,
        );
        return await realpath(candidate);
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return undefined;
}

async function runCapture(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      if (stdoutBytes < OUTPUT_LIMIT_BYTES) {
        stdout.push(chunk.subarray(0, OUTPUT_LIMIT_BYTES - stdoutBytes));
      }
      stdoutBytes += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      if (stderrBytes < OUTPUT_LIMIT_BYTES) {
        stderr.push(chunk.subarray(0, OUTPUT_LIMIT_BYTES - stderrBytes));
      }
      stderrBytes += chunk.length;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function requireGitHubAuthentication() {
  const result = await runCapture("gh", ["auth", "status", "--hostname", "github.com"]);
  if (result.code !== 0) {
    throw new Error(
      `GitHub CLI authentication is required before the benchmark:\n${result.stderr.trim()}`,
    );
  }
}

async function ghApi(endpoint) {
  const result = await runCapture("gh", [
    "api",
    "--header",
    "Accept: application/vnd.github+json",
    endpoint,
  ]);
  if (result.code !== 0) {
    return undefined;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return {};
  }
}

async function ensureRemoteDoesNotExist(owner, repositoryName) {
  if ((await ghApi(`repos/${owner}/${repositoryName}`)) !== undefined) {
    throw new Error(`Refusing to reuse existing repository ${owner}/${repositoryName}`);
  }
}

async function createMcpFiles(runDirectory, trialDirectory) {
  const npmExecutable = await executableOnPath("npm");
  if (npmExecutable === undefined) {
    throw new Error("npm is required for the MCP benchmark mode");
  }
  const rgExecutable = await executableOnPath("rg");
  const trustedDirectories = new Set([
    path.dirname(process.execPath),
    path.dirname(npmExecutable),
  ]);
  if (rgExecutable !== undefined) {
    trustedDirectories.add(path.dirname(rgExecutable));
  }
  for (const candidate of ["/usr/bin", "/bin"]) {
    if (await exists(candidate)) {
      trustedDirectories.add(await realpath(candidate));
    }
  }
  const commands = {
    node: {
      allowed: true,
      path: await realpath(process.execPath),
      readOnly: false,
    },
    npm: {
      allowed: true,
      path: npmExecutable,
      allowedSubcommands: ["run", "test"],
      readOnly: false,
    },
    git: {
      allowed: true,
      allowedSubcommands: ["status", "diff", "log", "show", "rev-parse", "ls-files"],
      readOnly: true,
    },
  };
  if (rgExecutable !== undefined) {
    commands.rg = {
      allowed: true,
      path: rgExecutable,
      readOnly: true,
    };
  }
  const policy = {
    workspaceRoots: [trialDirectory],
    maxBatchSize: 16,
    maxConcurrency: 16,
    defaultConcurrency: 4,
    defaultTimeoutMs: 120_000,
    maxTimeoutMs: 300_000,
    defaultMaxOutputBytes: 256 * 1024,
    absoluteMaxOutputBytes: 1024 * 1024,
    allowedEnvironmentKeys: [],
    trustedExecutableDirectories: [...trustedDirectories],
    commands,
    logLevel: "info",
    readOnly: false,
  };
  const policyPath = path.join(runDirectory, "mcp-policy.json");
  await writeFile(policyPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");

  const serverEntry = path.resolve("dist", "mcp", "stdio.js");
  await access(serverEntry, constants.R_OK);
  const mcpConfiguration = {
    mcpServers: {
      "os-batch": {
        type: "stdio",
        command: process.execPath,
        args: [serverEntry],
        env: {
          OS_BATCH_POLICY_FILE: policyPath,
          OS_BATCH_WORKSPACE_ROOT: trialDirectory,
        },
      },
    },
  };
  const mcpConfigPath = path.join(runDirectory, "mcp.json");
  await writeFile(
    mcpConfigPath,
    `${JSON.stringify(mcpConfiguration, null, 2)}\n`,
    "utf8",
  );
  return mcpConfigPath;
}

function renderTemplate(template, replacements) {
  return template.replaceAll(PLACEHOLDER_PATTERN, (match, name) => {
    const replacement = replacements[name];
    if (replacement === undefined) {
      throw new Error(`Unknown template placeholder: ${match}`);
    }
    return replacement;
  });
}

function phaseRecorder(startedAt) {
  const phases = {};
  return {
    phases,
    record(name) {
      if (phases[name] !== undefined) {
        return;
      }
      const observedAt = Date.now();
      phases[name] = {
        observed_at: new Date(observedAt).toISOString(),
        elapsed_ms: observedAt - startedAt,
      };
      process.stdout.write(`${name}=${phases[name].elapsed_ms}ms\n`);
    },
  };
}

async function pageContainsMarker(pageUrl, runId) {
  try {
    const separator = pageUrl.includes("?") ? "&" : "?";
    const response = await globalThis.fetch(
      `${pageUrl}${separator}benchmark=${Date.now()}`,
      {
        headers: { "cache-control": "no-cache" },
        redirect: "follow",
        signal: globalThis.AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      return false;
    }
    return (await response.text()).includes(runId);
  } catch {
    return false;
  }
}

async function observePhases(context) {
  const { owner, repositoryName, trialDirectory, pageUrl, runId, recorder } = context;
  if (await exists(path.join(trialDirectory, ".git"))) {
    recorder.record("local_repository_created");
  }
  if (
    (await exists(path.join(trialDirectory, "package.json"))) &&
    (await exists(path.join(trialDirectory, "src")))
  ) {
    recorder.record("application_source_created");
  }
  const repository = await ghApi(`repos/${owner}/${repositoryName}`);
  if (repository === undefined) {
    return;
  }
  recorder.record("remote_repository_created");
  if ((await ghApi(`repos/${owner}/${repositoryName}/commits/main`)) !== undefined) {
    recorder.record("main_branch_pushed");
  }
  const pages = await ghApi(`repos/${owner}/${repositoryName}/pages`);
  if (pages === undefined) {
    return;
  }
  recorder.record("pages_configured");
  if (await pageContainsMarker(pageUrl, runId)) {
    recorder.record("page_live");
  }
}

function terminateProcessTree(child, force = false) {
  if (child.exitCode !== null || child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    const killer = spawn(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/PID", String(child.pid), "/T", "/F"],
      { shell: false, stdio: "ignore" },
    );
    killer.unref();
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch {
    child.kill(force ? "SIGKILL" : "SIGTERM");
  }
}

async function startAgent(command, args, prompt, options) {
  const stdoutHandle = await open(options.stdoutPath, "w");
  const stderrHandle = await open(options.stderrPath, "w");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["pipe", stdoutHandle.fd, stderrHandle.fd],
  });
  child.stdin.end(prompt);
  const completion = new Promise((resolve) => {
    child.once("error", (error) => {
      resolve({ code: null, signal: null, error: error.message });
    });
    child.once("close", (code, signal) => {
      resolve({ code, signal, error: null });
    });
  }).finally(async () => {
    await Promise.all([stdoutHandle.close(), stderrHandle.close()]);
  });
  return { child, completion };
}

async function delay(milliseconds) {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

const arguments_ = parseArguments(process.argv.slice(2));
const configPath = path.resolve(arguments_.config);
const untrustedConfiguration = JSON.parse(await readFile(configPath, "utf8"));
const configuration = validateConfiguration(
  untrustedConfiguration,
  arguments_.mode,
  configPath,
);
await requireGitHubAuthentication();

const runId = timestampName();
const trialLabel =
  arguments_.trial === undefined
    ? runId
    : requireString(arguments_.trial, "trial").replaceAll(/[^A-Za-z0-9._-]/g, "-");
const repositoryName = `${configuration.repositoryPrefix}-${configuration.mode.name}-${runId}`;
if (repositoryName.length > 100) {
  throw new Error("Generated GitHub repository name exceeds 100 characters");
}
await ensureRemoteDoesNotExist(configuration.owner, repositoryName);

const trialDirectory = path.join(configuration.workspaceRoot, repositoryName);
const runDirectory = path.join(configuration.resultsDirectory, repositoryName);
await Promise.all([
  mkdir(trialDirectory, { recursive: false }),
  mkdir(runDirectory, { recursive: true }),
]);

const pageUrl = `https://${configuration.owner.toLowerCase()}.github.io/${repositoryName}/`;
const repositoryUrl = `https://github.com/${configuration.owner}/${repositoryName}`;
const mcpConfigPath = configuration.mode.mcpEnabled
  ? await createMcpFiles(runDirectory, trialDirectory)
  : "";
const promptTemplatePath = path.resolve(
  path.dirname(configPath),
  requireString(untrustedConfiguration.promptFile, "promptFile"),
);
const promptTemplate = await readFile(promptTemplatePath, "utf8");
const replacements = {
  OWNER: configuration.owner,
  REPOSITORY_NAME: repositoryName,
  REPOSITORY_URL: repositoryUrl,
  PAGE_URL: pageUrl,
  RUN_ID: runId,
  MODE: configuration.mode.name,
  MCP_CONFIG: mcpConfigPath,
  WORKSPACE: trialDirectory,
};
const prompt = renderTemplate(promptTemplate, replacements);
const agentArgs = configuration.mode.args.map((argument) =>
  renderTemplate(argument, replacements),
);
await writeFile(path.join(runDirectory, "prompt.md"), prompt, "utf8");

const startedAt = Date.now();
const recorder = phaseRecorder(startedAt);
const agent = await startAgent(configuration.mode.command, agentArgs, prompt, {
  cwd: trialDirectory,
  env: { ...process.env, ...configuration.mode.environment },
  stdoutPath: path.join(runDirectory, "agent.stdout.jsonl"),
  stderrPath: path.join(runDirectory, "agent.stderr.log"),
});
let agentResult;
let agentExitedAt;
let terminatedForTimeout = false;
let terminationRequestedAt;
agent.completion.then((result) => {
  agentResult = result;
  agentExitedAt = Date.now();
  recorder.record("agent_process_exited");
});

const observationContext = {
  owner: configuration.owner,
  repositoryName,
  trialDirectory,
  pageUrl,
  runId,
  recorder,
};
while (true) {
  await observePhases(observationContext);
  if (recorder.phases.page_live !== undefined && agentResult !== undefined) {
    break;
  }
  const now = Date.now();
  if (agentResult === undefined && now - startedAt > configuration.agentTimeoutMs) {
    if (terminationRequestedAt === undefined) {
      terminatedForTimeout = true;
      terminationRequestedAt = now;
      terminateProcessTree(agent.child);
    } else if (now - terminationRequestedAt > 5_000) {
      terminateProcessTree(agent.child, true);
    }
  }
  if (
    agentExitedAt !== undefined &&
    now - agentExitedAt > configuration.deploymentTimeoutMs
  ) {
    break;
  }
  await delay(configuration.pollIntervalMs);
}
if (agentResult === undefined) {
  agentResult = await agent.completion;
}
await observePhases(observationContext);

const endedAt = Date.now();
const success = agentResult.code === 0 && recorder.phases.page_live !== undefined;
const result = {
  schema_version: 1,
  benchmark: "repository-to-github-pages",
  run_id: runId,
  trial_label: trialLabel,
  mode: configuration.mode.name,
  mode_label: configuration.mode.label,
  mcp_enabled: configuration.mode.mcpEnabled,
  agent: {
    command: configuration.mode.command,
    model: configuration.mode.model,
    arguments_recorded: false,
  },
  started_at: new Date(startedAt).toISOString(),
  ended_at: new Date(endedAt).toISOString(),
  elapsed_ms: endedAt - startedAt,
  success,
  agent_exit: {
    code: agentResult.code,
    signal: agentResult.signal,
    error: agentResult.error,
    terminated_for_timeout: terminatedForTimeout,
  },
  repository: {
    owner: configuration.owner,
    name: repositoryName,
    visibility: "public",
    url: repositoryUrl,
  },
  pages: {
    url: pageUrl,
    source: { branch: "main", path: "/docs", build_type: "legacy" },
    marker: runId,
  },
  phases: recorder.phases,
  artifacts: {
    workspace: trialDirectory,
    agent_stdout: path.join(runDirectory, "agent.stdout.jsonl"),
    agent_stderr: path.join(runDirectory, "agent.stderr.log"),
    prompt: path.join(runDirectory, "prompt.md"),
  },
  notes: [
    "AI/model reasoning is not directly observable; elapsed time includes model, tool orchestration, commands, and external services.",
    "The public repository is intentionally not deleted automatically.",
  ],
};
const resultPath = path.join(runDirectory, "result.json");
await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
process.stdout.write(`success=${success}\n`);
process.stdout.write(`repository=${repositoryUrl}\n`);
process.stdout.write(`pages=${pageUrl}\n`);
process.stdout.write(`result=${resultPath}\n`);
if (!success) {
  process.exitCode = 1;
}
