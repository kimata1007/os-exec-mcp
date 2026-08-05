# os-exec-mcp

A secure, local-first Model Context Protocol server that lets Codex and Claude Code
request independent operating-system commands with `batch_exec`, or submit a
dependency-aware command DAG with `workflow_exec`. The server validates the whole
request, applies a server-owned policy, runs every ready command with bounded
concurrency, and returns one compact ordered result.

```text
MCP client
  ├─ batch_exec
  │    ├─ git status --short
  │    ├─ rg TODO
  │    └─ git log -5
  │       ↓ bounded parallel execution
  │    one ordered structured response
  │
  └─ workflow_exec
       install → format ┬→ lint
                        ├→ typecheck
                        ├→ test
                        └→ build
          ↓ dependency-aware parallel execution
       one ordered structured response
```

The standard transport is local stdio. The execution core has no MCP transport
dependency, so a separately hardened Streamable HTTP adapter can be added later
without changing command policy or process management.

## Quick start

Requirements:

- Node.js 20.19 or newer
- npm
- Codex, Claude Code, or another MCP client that supports stdio

Register the safe read-only mode in Codex:

```bash
codex mcp add os-exec -- npx -y os-exec-mcp
```

For trusted development workspaces, enable the bundled development denylist policy:

```bash
codex mcp add os-exec -- npx -y os-exec-mcp --development
```

Restart Codex after registration. The MCP server starts in the active workspace, so
no checkout-specific absolute path is required. The default mode allows configured
repository-reading commands only. `--development` permits executables inherited from
the parent `PATH` except the server denylist; it is not an OS sandbox and should be
used only with trusted repositories inside an existing sandbox or low-privilege
environment.

The production MCP dependency is pinned to
`@modelcontextprotocol/sdk@1.29.0`. The project uses TypeScript, ESM, strict type
checking, Vitest, ESLint, and Prettier.

## Install from source and verify

```bash
git clone https://github.com/kimata1007/os-exec-mcp.git
cd os-exec-mcp
npm ci
npm run check
```

Build output is written to `dist/`. Start the stdio server directly with:

```bash
OS_EXEC_WORKSPACE_ROOT="$PWD" node dist/mcp/stdio.js
```

The process waits for MCP JSON-RPC on stdin. Logs go only to stderr.

## Architecture

The layers have deliberately narrow boundaries:

1. `src/mcp/` defines the MCP server, tool schemas, instructions, and stdio lifecycle.
2. `src/validation/` validates request shape and server limit overrides.
3. `src/policy/` resolves canonical workspaces and executables, applies command and
   environment allowlists, and rejects unsafe built-in options.
4. `src/executor/batch-executor.ts` provides the fair FIFO queue, concurrency limit,
   result ordering, `continue`, and `fail_fast`.
5. `src/executor/workflow-executor.ts` schedules an acyclic dependency graph, unlocks
   ready nodes, propagates blocked dependencies, and measures peak concurrency.
6. `src/executor/process-runner.ts` spawns one process without a shell, drains both
   output streams, handles timeout/cancellation, and records duration.
7. `src/executor/output-buffer.ts` bounds retained output while continuing to drain
   pipes.
8. `src/observability/` emits redacted JSON logs to stderr.

`BatchExecutor`, `WorkflowExecutor`, `CommandPolicyEvaluator`, and `ProcessRunner` do
not import MCP transport classes. This is the boundary intended for future transports
and embedding.

## `batch_exec`

### Input

```json
{
  "commands": [
    {
      "id": "git-status",
      "argv": ["git", "status", "--short"],
      "cwd": ".",
      "timeout_ms": 10000,
      "env": {}
    }
  ],
  "concurrency": 4,
  "failure_mode": "continue",
  "max_output_bytes": 65536
}
```

- `commands` is required, non-empty, ordered, and limited by `maxBatchSize` (16 by
  default).
- `id` is unique within the batch, at most 64 characters, and restricted to safe
  identifier characters.
- `argv` is a non-empty array. `argv[0]` is a simple executable name. The server never
  accepts a shell string, never enables shell expansion, and limits argument count and
  length.
- `cwd` defaults to the first workspace root. Relative paths resolve from that root.
  The canonical existing directory must remain inside one configured root after
  symlink resolution.
- `timeout_ms` defaults to 10 seconds and is limited to 60 seconds by the default
  policy.
- `env` defaults to empty. A client may set only keys approved by the server, and may
  never replace execution-sensitive variables such as `PATH`, loader variables,
  shell initialization, proxy configuration, or common credential variables.
- `concurrency` defaults to 8 and cannot exceed the policy maximum (16 by default) or
  the command count.
- `max_output_bytes` is a per-command, per-stream limit: stdout and stderr each retain
  up to this many bytes. Both pipes continue to be read after truncation.

Static schema violations and requests above server limits return a tool-level
structured error. An individual command failure is represented in the normal result
and does not turn the entire MCP call into a protocol error.

### Result

```json
{
  "request_id": "787b7a40-4491-4d92-bfb1-81b2b97ee42e",
  "results": [
    {
      "id": "git-status",
      "status": "success",
      "exit_code": 0,
      "signal": null,
      "stdout": "",
      "stderr": "",
      "stdout_bytes": 0,
      "stderr_bytes": 0,
      "stdout_truncated": false,
      "stderr_truncated": false,
      "duration_ms": 42,
      "error": null,
      "rejection_reason": null
    }
  ],
  "summary": {
    "total": 1,
    "succeeded": 1,
    "failed": 0,
    "timed_out": 0,
    "cancelled": 0,
    "skipped": 0,
    "rejected": 0,
    "spawn_errors": 0,
    "wall_time_ms": 44,
    "effective_concurrency": 1
  }
}
```

Results always match input order. Status values are:

- `success`: exit code 0
- `failed`: the process started and exited non-zero
- `timeout`: the per-command deadline expired
- `cancelled`: an MCP/request/server cancellation stopped the command
- `skipped`: fail-fast stopped the queue before the command started
- `rejected`: policy evaluation refused the command
- `spawn_error`: the approved executable could not be spawned

Invalid UTF-8 is decoded with replacement characters instead of crashing the server.
`stdout_bytes` and `stderr_bytes` are byte counts before truncation.

## `workflow_exec`

Use `workflow_exec` when a task has multiple dependency stages that would otherwise
require another model response between each stage. It accepts the same command fields
and limits as `batch_exec`, plus `depends_on`, an array of direct predecessor IDs.

```json
{
  "commands": [
    {
      "id": "install",
      "argv": ["npm", "install"],
      "timeout_ms": 120000
    },
    {
      "id": "format",
      "argv": ["npm", "run", "format"],
      "depends_on": ["install"]
    },
    {
      "id": "lint",
      "argv": ["npm", "run", "lint"],
      "depends_on": ["format"]
    },
    {
      "id": "typecheck",
      "argv": ["npm", "run", "typecheck"],
      "depends_on": ["format"]
    },
    {
      "id": "test",
      "argv": ["npm", "test"],
      "depends_on": ["format"]
    },
    {
      "id": "build",
      "argv": ["npm", "run", "build"],
      "depends_on": ["format"]
    }
  ],
  "concurrency": 4,
  "failure_mode": "continue"
}
```

The graph must be acyclic. IDs and dependencies are validated before any command
starts: duplicate IDs, duplicate dependencies, self-dependencies, unknown IDs, and
cycles reject the complete request.

Commands with no dependencies start immediately, subject to the concurrency limit.
A command becomes ready only after all of its direct dependencies succeed. In
`continue` mode, a failed, timed-out, cancelled, rejected, or unspawnable dependency
marks its descendants as `skipped`, while unrelated branches continue. A skipped
result includes:

```json
{
  "id": "test",
  "status": "skipped",
  "depends_on": ["install"],
  "blocked_by": ["install"],
  "error": "Dependency did not succeed: install"
}
```

Every workflow result includes `depends_on` and `blocked_by`. Its summary has all
`batch_exec` counters plus `peak_concurrency`, the highest number of commands actually
running at once. Results remain in input order rather than completion order.

## Failure modes

Use `failure_mode: "continue"` for independent repository inspection and workflows
whose unrelated branches remain useful. In `batch_exec`, a rejected, failed, or
timed-out command does not prevent other commands from running. In `workflow_exec`, it
blocks only descendants that require it.

Use `failure_mode: "fail_fast"` only when one failure invalidates later work. After
the first observed failure, the executor:

- starts no more queued commands,
- marks commands that never started as `skipped`,
- cancels in-flight commands through their process tree,
- preserves completed results and their side effects.

No rollback is attempted. Do not batch ordered Git operations, writes to the same
file, or operations that compete for one mutable resource.

## Policy

Set `OS_EXEC_POLICY_FILE` to a strict JSON policy. A malformed file, unknown field,
missing root, missing explicitly configured executable directory, or inconsistent
limit causes startup to fail closed.

```json
{
  "workspaceRoots": ["."],
  "maxBatchSize": 16,
  "maxConcurrency": 16,
  "defaultConcurrency": 8,
  "defaultTimeoutMs": 10000,
  "maxTimeoutMs": 60000,
  "defaultMaxOutputBytes": 65536,
  "absoluteMaxOutputBytes": 1048576,
  "allowedEnvironmentKeys": [],
  "inheritExecutablePath": false,
  "commandMode": "allowlist",
  "deniedCommands": [],
  "commands": {
    "git": {
      "allowed": true,
      "allowedSubcommands": ["status", "diff", "log", "show", "rev-parse", "ls-files"],
      "readOnly": true
    },
    "rg": {
      "allowed": true,
      "path": "/absolute/path/to/rg",
      "readOnly": true
    },
    "ls": {
      "allowed": true,
      "readOnly": true
    },
    "find": {
      "allowed": true,
      "readOnly": true
    }
  },
  "logLevel": "info",
  "readOnly": true
}
```

Relative `workspaceRoots`, command `path` values, and explicit
`trustedExecutableDirectories` are resolved relative to the policy file. A command
`path` must be absolute. Explicit paths are the recommended way to allow tools outside
the system directories.

The environment may set:

| Variable                 | Meaning                                        |
| ------------------------ | ---------------------------------------------- |
| `OS_EXEC_POLICY_FILE`    | Policy JSON path                               |
| `OS_EXEC_WORKSPACE_ROOT` | Replace configured roots with one startup root |
| `OS_EXEC_LOG_LEVEL`      | `debug`, `info`, `warn`, `error`, or `silent`  |
| `OS_EXEC_READ_ONLY`      | `true`/`false` or `1`/`0`                      |

Environment values are server-administrator configuration, not tool input.
The former `OS_BATCH_*` names remain accepted as migration aliases during the 0.x
series. Do not set both forms to different values; conflicting values fail startup.

Two example policies are included:

| Policy                             | Mode      | Behavior                                                                                      |
| ---------------------------------- | --------- | --------------------------------------------------------------------------------------------- |
| `examples/policy.read-only.json`   | allowlist | Permits only configured repository-reading commands                                           |
| `examples/policy.development.json` | denylist  | Permits every executable found in the inherited parent `PATH`, except explicitly denied names |

The development policy has an empty `commands` object. `commandMode: "denylist"`
means an executable does not need a per-command entry: if it is available on the
inherited `PATH` and its name is not in `deniedCommands`, it is allowed.

The development denylist includes direct destructive, privilege-changing,
interactive, system-management, remote-login, global-package-manager, and command
wrapper executables. Examples include shells, `sudo`, `rm`, `dd`, `chmod`, `kill`,
interactive editors and pagers, `ssh`, `brew`, `docker`, `env`, and `xargs`. The
server's built-in shell and privilege-elevation denylist still applies even if an
operator removes those names from the JSON list.

This denylist reduces accidental direct execution; it is not a security sandbox.
Allowed runtimes and build tools such as `node`, Python, npm scripts, and `make` can
execute other programs or modify arbitrary data available to the server process. Use
the allowlist policy for untrusted repository content, and run the development policy
inside a container or dedicated low-privilege account when stronger isolation is
required.

### Command selection modes

- `commandMode: "allowlist"`: only entries with `allowed: true` in `commands` run.
- `commandMode: "denylist"`: any resolved executable runs unless its name appears in
  `deniedCommands`; an explicit `commands` entry can still apply a path or subcommand
  restriction.
- `inheritExecutablePath: true`: canonical, accessible directories from the server
  process's parent `PATH` become trusted executable directories; executable symlink
  targets exposed by those directories are accepted like normal parent-process PATH
  lookup.
- `inheritExecutablePath: false`: only explicit trusted directories, the Node runtime
  directory, and system executable directories are considered.

### What to batch

Batch all independent operations. Common examples include:

```text
ls src
find test -type f
rg TODO src test
git status --short
```

Independent reads of different files should also be batched:

```text
head -n 80 src/server.ts
tail -n 80 src/executor.ts
wc -l README.md src/index.ts
stat package.json tsconfig.json
```

The development policy also permits independent writes to different targets, for
example creating separate directories or copying unrelated assets:

```text
mkdir docs/assets
mkdir coverage/unit
cp public/logo.svg docs/assets/logo.svg
touch docs/.nojekyll
```

Do not put commands with a data dependency or a shared mutable target into
`batch_exec`. Express their required order with `workflow_exec.depends_on`, for
example:

- `npm install` followed by `npm test`;
- multiple updates to the same file;
- `git add` followed by `git commit`;
- a build followed by a command that consumes its output.

Declaring dependencies does not detect undeclared file or resource conflicts. The
client must still declare every ordering constraint needed to prevent unsafe
concurrent mutation.

### Adding a command

1. Prefer an absolute canonical `path`.
2. Decide whether the executable is truly safe in read-only mode.
3. Add `allowedSubcommands` when the executable multiplexes different operations.
4. Review options that can launch helpers, write files, load plugins/configuration, or
   access resources outside the workspace.
5. Add policy and execution tests before deploying the rule.

The server has built-in guards for:

- Git: optional configured subcommand restrictions, no pager, external diff, text
  conversion, signature helper, output-file option, `--no-index`, or optional index
  locks.
- ripgrep: no preprocessors, hostname helpers, symlink following, absolute paths, or
  parent traversal.
- `find`: no `-exec`, `-delete`, `-ok`, or output-to-file actions.
- Workspace-oriented file commands (`ls`, `find`, `cat`, `head`, `tail`, `wc`,
  `stat`, `du`, `mkdir`, `cp`, `mv`, and `touch`): no absolute paths, parent
  traversal, or absolute path values embedded in options.

Package managers, build tools, language runtimes, test runners, Git hooks, and plugin
hosts can execute arbitrary code. The development denylist mode deliberately allows
these unless their executable name is denied; use the read-only allowlist policy
instead when executing untrusted repository content.

## Secure defaults and threat model

The implementation enforces:

- `shell: false`; no `eval`, `sh -c`, `bash -c`, `cmd /c`, or PowerShell command mode
- argv arrays only; stdin ignored and no TTY
- allowlist or denylist command selection, with optional per-command restrictions
- shells and privilege-elevation executables denied even if listed
- canonical workspace and symlink-boundary checks for `cwd`
- canonical executable resolution and trusted-directory checks
- a minimal child environment with client `PATH` replacement denied
- command, batch, concurrency, timeout, and retained-output limits
- simultaneous draining of stdout and stderr
- process-tree termination on timeout, cancellation, disconnect, and shutdown
- JSON logs on stderr only; output bodies, argument arrays, and environment maps are
  not logged
- masking of fields whose names indicate tokens, secrets, credentials, arguments,
  environment, stdout, or stderr

Important boundaries:

- This server is not a filesystem, network, syscall, container, or user-identity
  sandbox.
- `workspaceRoots` constrains process working directories and built-in path checks; it
  does not create a virtual filesystem. An allowed executable may have other ways to
  access host resources.
- `readOnly` is a policy classification plus built-in hardening, not an OS guarantee.
  A wrongly classified command can still mutate data.
- An executable can spawn descendants or escape ordinary process groups using
  platform facilities. Tree cleanup is best effort.
- Command output is returned to the MCP client. Do not run commands that print
  credentials, and keep the server process free of unnecessary secrets.
- There is a small validation-to-spawn race if an administrator replaces an allowed
  executable after canonical validation.

For stronger isolation, run the server as a dedicated low-privilege OS user or inside
a container/VM with a read-only filesystem where appropriate, restricted network
access, resource limits, and only the required workspace mounted.

## Process management and platform differences

- macOS/Linux: each command starts in a detached process group. Cancellation sends
  `SIGTERM` to the group and follows with `SIGKILL` after a short grace period.
- Windows: commands start without a shell and without a visible window. Cancellation
  uses the absolute system `taskkill.exe /T /F` path for the known child PID, with a
  direct child termination fallback.
- Windows executable lookup considers `.exe` and `.com`, not shell-backed `.cmd` or
  `.bat`.
- Exit signals are normally available on POSIX and may be `null` on Windows.
- Policies containing Unix absolute paths are not portable; use per-machine policy
  files or explicit environment configuration.

CI exercises Node 20 on Linux, macOS, and Windows, plus Node 24 on Linux.

## Logging and observability

Logs are newline-delimited JSON on stderr. The default level is `info`.

Startup fields include `command_mode`, `denied_command_count`,
`inherited_executable_path`, `read_only`, and concurrency limits.

Batch fields include `request_id`, `batch_size`, `effective_concurrency`,
`wall_time_ms`, and status counts. Command fields include `command_id`, canonical
`executable`, status, exit code, duration, timeout, byte counts, truncation, and
rejection reason.

Workflow fields additionally include `workflow_size` and `peak_concurrency`.

The logger does not record command arguments, client environment maps, or output
bodies. `request_id` is also returned to the client for correlation.

## Tests

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

The test suite covers validation, policy decisions, path traversal and symlink escape,
environment and `PATH` injection, simultaneous large output, invalid UTF-8, non-zero
exit, spawn error, timeout, process-tree cleanup, output truncation, ordering,
concurrency, actual wall-clock parallelism, DAG validation and scheduling, dependency
failure propagation, partial failure, fail-fast, cancellation, shutdown, MCP
initialize, `tools/list`, `tools/call`, and stderr logging.

## Codex setup

The zero-configuration npm setup uses the active workspace as the policy root:

```bash
codex mcp add os-exec -- npx -y os-exec-mcp
codex mcp list
```

Add `--development` after the package name for the bundled development policy.
For durable fine-grained configuration, copy
[`examples/codex-config.toml`](examples/codex-config.toml) into
`~/.codex/config.toml` or a trusted project's `.codex/config.toml` and replace every
placeholder. Codex's desktop app, CLI, and IDE extension share this MCP
configuration. Restart the client after changing the server registration.

Suggested Codex instruction:

```text
Proactively use os-exec batch_exec for independent OS operations. Batch repository
discovery, reads, checks, and non-conflicting writes. Use workflow_exec for
multi-stage command DAGs and declare every ordering constraint with depends_on.
Use failure_mode=continue when independent branches remain useful. Never allow
commands that share a mutable target to run concurrently.
```

## Claude Code setup

Add the npm-hosted server with project scope:

```bash
claude mcp add \
  --transport stdio \
  --scope project \
  os-exec -- npx -y os-exec-mcp
claude mcp list
```

Add `--development` after the package name for the bundled development policy.
Project scope writes `.mcp.json` and prompts each teammate to approve the server.
Absolute paths are not team-portable. For a shared configuration:

1. set `OS_EXEC_MCP_HOME` to each developer's server checkout,
2. copy [`examples/claude-mcp.json`](examples/claude-mcp.json) to the consuming
   project's `.mcp.json`,
3. approve it in Claude Code's `/mcp` panel.

Claude Code expands `${VAR}` and `${VAR:-default}` in `.mcp.json`. The example uses
`${CLAUDE_PROJECT_DIR:-.}` for the workspace and an operator-supplied
`OS_EXEC_MCP_HOME` for the built server. Alternatively, install a packaged command
in one stable location or use a container/dev-container path shared by the team.

Suggested Claude Code instruction:

```text
Proactively call os-exec batch_exec for independent repository reads, checks, and
writes to different targets instead of making sequential Bash calls. Use ls and find
as part of parallel discovery. Use workflow_exec with depends_on for multi-stage
commands, ordered Git actions, and ordered writes to the same target.
```

## `AGENTS.md` and `CLAUDE.md` snippets

Add this to `AGENTS.md` for Codex-compatible repository guidance, and separately to
`CLAUDE.md` when the same rule should persist in Claude Code:

```markdown
## Parallel OS operations

- Use the os-exec MCP server for multiple independent OS operations.
- Batch only operations that have no data dependency and do not compete for the same
  mutable resource.
- Proactively batch repository discovery with ls, find, rg, and read-only Git.
- Batch independent reads of different files.
- Batch independent writes to different files or output directories.
- Use workflow_exec with depends_on for multi-stage command graphs.
- Use failure_mode=continue when partial results remain useful.
- Use failure_mode=fail_fast only when later work is invalid after one failure.
- Declare every ordering constraint for writes to the same file and ordered Git
  operations.
- Do not use shell command strings; provide argv arrays.
- Keep concurrency at or below the server-advertised limit.
- Do not retry rejected or deterministic failures without changing the request.
```

Keep `AGENTS.md` as repository operating guidance and `CLAUDE.md` as Claude Code
project memory; do not replace unrelated existing content.

## Troubleshooting

**Server fails at startup**

- Run `node dist/mcp/stdio.js` and inspect stderr.
- Validate the policy as strict JSON.
- Ensure workspace roots and explicitly configured trusted directories exist.
- Use an absolute command `path` when the executable is outside a trusted system
  directory.

**Command is `rejected`**

- Read `rejection_reason`.
- Confirm the executable, subcommand, environment key, `cwd`, timeout, and output
  request are within policy.
- Do not retry an unchanged deterministic rejection.

**Client connects but shows no tool**

- Run `codex mcp list` or `claude mcp get os-exec`.
- In Codex use `/mcp`; in Claude Code use `/mcp`.
- Rebuild after source changes and restart/reconnect the client.
- Claude Code can show server stderr with `claude --debug mcp`.

**Timeout leaves work behind**

- Treat tree termination as best effort and verify behavior for the allowed program
  on the target OS.
- Do not allow daemonizing programs or service managers.
- Use a container or dedicated user for stronger lifecycle isolation.

## Uninstall

Remove only the client registration:

```bash
codex mcp remove os-exec
claude mcp remove --scope project os-exec
```

Then remove the checkout if it is no longer needed. Client removal does not delete
the server repository or policy files.

## Streamable HTTP

HTTP is intentionally not included in this release. For local OS manipulation, stdio
has the smallest attack surface and naturally runs on the client host.

A future HTTP adapter should construct the same `BatchExecutor` but must additionally
provide localhost-only binding by default, mandatory authentication for non-loopback
binding, TLS termination, request size and connection limits, rate limiting, Host and
Origin validation, DNS-rebinding protection, session and idle-timeout management, and
graceful shutdown. CORS must not be open by default, and bearer tokens must never be
logged. Commands would run on the server host, not the remote MCP client's computer.

## License

MIT
