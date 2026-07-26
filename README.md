# os-batch-mcp

A secure, local-first Model Context Protocol server that lets Codex and Claude Code
request several independent operating-system commands in one `batch_exec` call. The
server validates the whole request, applies a server-owned policy, runs approved
commands with bounded concurrency, and returns one compact ordered result.

```text
MCP client
  └─ batch_exec (one MCP request)
       ├─ git status --short
       ├─ rg TODO
       └─ git log -5
          ↓ bounded parallel execution
       one ordered structured response
```

The standard transport is local stdio. The execution core has no MCP transport
dependency, so a separately hardened Streamable HTTP adapter can be added later
without changing command policy or process management.

## Requirements

- Node.js 20.19 or newer
- npm
- The executables explicitly allowed by your policy
- Codex, Claude Code, or another MCP client that supports stdio

The production MCP dependency is pinned to
`@modelcontextprotocol/sdk@1.29.0`. The project uses TypeScript, ESM, strict type
checking, Vitest, ESLint, and Prettier.

## Install and verify

```bash
git clone https://github.com/kimata1007/os-batch-mcp.git
cd os-batch-mcp
npm ci
npm run check
```

Build output is written to `dist/`. Start the stdio server directly with:

```bash
OS_BATCH_WORKSPACE_ROOT="$PWD" node dist/mcp/stdio.js
```

The process waits for MCP JSON-RPC on stdin. Logs go only to stderr.

## Architecture

The layers have deliberately narrow boundaries:

1. `src/mcp/` defines the MCP server, `batch_exec` schema, instructions, and stdio
   lifecycle.
2. `src/validation/` validates request shape and server limit overrides.
3. `src/policy/` resolves canonical workspaces and executables, applies command and
   environment allowlists, and rejects unsafe built-in options.
4. `src/executor/batch-executor.ts` provides the fair FIFO queue, concurrency limit,
   result ordering, `continue`, and `fail_fast`.
5. `src/executor/process-runner.ts` spawns one process without a shell, drains both
   output streams, handles timeout/cancellation, and records duration.
6. `src/executor/output-buffer.ts` bounds retained output while continuing to drain
   pipes.
7. `src/observability/` emits redacted JSON logs to stderr.

`BatchExecutor`, `CommandPolicyEvaluator`, and `ProcessRunner` do not import MCP
transport classes. This is the boundary intended for future transports and embedding.

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
- `concurrency` defaults to 4 and cannot exceed the policy maximum (8 by default) or
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

## Failure modes

Use `failure_mode: "continue"` for independent repository inspection. A rejected,
failed, or timed-out command does not prevent other commands from running.

Use `failure_mode: "fail_fast"` only when one failure invalidates later work. After
the first observed failure, the executor:

- starts no more queued commands,
- marks commands that never started as `skipped`,
- cancels in-flight commands through their process tree,
- preserves completed results and their side effects.

No rollback is attempted. Do not batch ordered Git operations, writes to the same
file, or operations that compete for one mutable resource.

## Policy

Set `OS_BATCH_POLICY_FILE` to a strict JSON policy. A malformed file, unknown field,
missing root, missing explicitly configured executable directory, or inconsistent
limit causes startup to fail closed.

```json
{
  "workspaceRoots": ["."],
  "maxBatchSize": 16,
  "maxConcurrency": 8,
  "defaultConcurrency": 4,
  "defaultTimeoutMs": 10000,
  "maxTimeoutMs": 60000,
  "defaultMaxOutputBytes": 65536,
  "absoluteMaxOutputBytes": 1048576,
  "allowedEnvironmentKeys": [],
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

| Variable                  | Meaning                                        |
| ------------------------- | ---------------------------------------------- |
| `OS_BATCH_POLICY_FILE`    | Policy JSON path                               |
| `OS_BATCH_WORKSPACE_ROOT` | Replace configured roots with one startup root |
| `OS_BATCH_LOG_LEVEL`      | `debug`, `info`, `warn`, `error`, or `silent`  |
| `OS_BATCH_READ_ONLY`      | `true`/`false` or `1`/`0`                      |

Environment values are server-administrator configuration, not `batch_exec` input.

### Adding a command

1. Prefer an absolute canonical `path`.
2. Decide whether the executable is truly safe in read-only mode.
3. Add `allowedSubcommands` when the executable multiplexes different operations.
4. Review options that can launch helpers, write files, load plugins/configuration, or
   access resources outside the workspace.
5. Add policy and execution tests before deploying the rule.

The server has built-in guards for:

- Git: only configured subcommands, no pager, external diff, text conversion,
  signature helper, output-file option, `--no-index`, or optional index locks.
- ripgrep: no preprocessors, hostname helpers, symlink following, absolute paths, or
  parent traversal.
- `find`: no `-exec`, `-delete`, `-ok`, or output-to-file actions when an operator
  explicitly enables it.

Package managers, build tools, language runtimes, test runners, Git hooks, and plugin
hosts can execute arbitrary code. Do not allow them merely because their executable
name looks familiar. The test and benchmark policies allow `node` only to execute the
repository's cross-platform fixture; the production default does not allow it.

## Secure defaults and threat model

The implementation enforces:

- `shell: false`; no `eval`, `sh -c`, `bash -c`, `cmd /c`, or PowerShell command mode
- argv arrays only; stdin ignored and no TTY
- explicit command and optional subcommand allowlists
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

Batch fields include `request_id`, `batch_size`, `effective_concurrency`,
`wall_time_ms`, and status counts. Command fields include `command_id`, canonical
`executable`, status, exit code, duration, timeout, byte counts, truncation, and
rejection reason.

The logger does not record command arguments, client environment maps, or output
bodies. `request_id` is also returned to the client for correlation.

## Tests and benchmark

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run benchmark
```

The test suite covers validation, policy decisions, path traversal and symlink escape,
environment and `PATH` injection, simultaneous large output, invalid UTF-8, non-zero
exit, spawn error, timeout, process-tree cleanup, output truncation, ordering,
concurrency, actual wall-clock parallelism, partial failure, fail-fast, cancellation,
shutdown, MCP initialize, `tools/list`, `tools/call`, and stderr logging.

The benchmark runs four 250 ms Node fixture processes first with concurrency 1 and
then with concurrency 4:

```text
sequential_wall_time_ms=1915
batch_wall_time_ms=431
speedup=4.44
commands=4
concurrency=4
```

This sample was measured on the development macOS host on 2026-07-26. It is a
development demonstration, not a performance guarantee.

## Codex setup

Build first, then register the absolute compiled entry point. For this checkout:

```bash
codex mcp add os-batch \
  --env OS_BATCH_POLICY_FILE=/Users/kimata/Desktop/dev/os-batch-mcp/examples/policy.read-only.json \
  --env OS_BATCH_WORKSPACE_ROOT=/absolute/path/to/workspace \
  -- node /Users/kimata/Desktop/dev/os-batch-mcp/dist/mcp/stdio.js
codex mcp list
```

For durable fine-grained configuration, copy
[`examples/codex-config.toml`](examples/codex-config.toml) into
`~/.codex/config.toml` or a trusted project's `.codex/config.toml` and replace every
placeholder. Codex's desktop app, CLI, and IDE extension share this MCP
configuration. Restart the client after changing the server registration.

Suggested Codex instruction:

```text
Inspect this repository. Batch independent, non-conflicting, read-only commands
through os-batch batch_exec. Use failure_mode=continue when partial results remain
useful. Keep ordered writes and multiple writes to the same file sequential.
```

## Claude Code setup

Build first, then add the server. All Claude options precede the server name:

```bash
claude mcp add \
  --transport stdio \
  --scope project \
  --env OS_BATCH_POLICY_FILE=/Users/kimata/Desktop/dev/os-batch-mcp/examples/policy.read-only.json \
  --env OS_BATCH_WORKSPACE_ROOT=/absolute/path/to/workspace \
  os-batch -- node /Users/kimata/Desktop/dev/os-batch-mcp/dist/mcp/stdio.js
claude mcp list
```

Project scope writes `.mcp.json` and prompts each teammate to approve the server.
Absolute paths are not team-portable. For a shared configuration:

1. set `OS_BATCH_MCP_HOME` to each developer's server checkout,
2. copy [`examples/claude-mcp.json`](examples/claude-mcp.json) to the consuming
   project's `.mcp.json`,
3. approve it in Claude Code's `/mcp` panel.

Claude Code expands `${VAR}` and `${VAR:-default}` in `.mcp.json`. The example uses
`${CLAUDE_PROJECT_DIR:-.}` for the workspace and an operator-supplied
`OS_BATCH_MCP_HOME` for the built server. Alternatively, install a packaged command
in one stable location or use a container/dev-container path shared by the team.

Suggested Claude Code instruction:

```text
When several independent read-only OS operations are needed, call os-batch
batch_exec once instead of making sequential Bash calls. Do not parallelize dependent
operations, ordered Git actions, or writes to the same file.
```

## `AGENTS.md` and `CLAUDE.md` snippets

Add this to `AGENTS.md` for Codex-compatible repository guidance, and separately to
`CLAUDE.md` when the same rule should persist in Claude Code:

```markdown
## Parallel OS operations

- Use the os-batch MCP server for multiple independent OS operations.
- Batch only operations that have no data dependency and do not compete for the same
  mutable resource.
- Prefer batch_exec for read-only repository inspection.
- Use failure_mode=continue when partial results remain useful.
- Use failure_mode=fail_fast only when later work is invalid after one failure.
- Do not batch writes to the same file.
- Do not batch ordered Git operations.
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

- Run `codex mcp list` or `claude mcp get os-batch`.
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
codex mcp remove os-batch
claude mcp remove --scope project os-batch
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
