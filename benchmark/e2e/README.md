# End-to-end AI agent benchmark

This benchmark measures time from an empty directory to a verified public GitHub
Pages deployment. It complements, rather than replaces, the component benchmark.

## What it measures

The fixed task in `task.md` requires an agent to:

1. initialize a local repository;
2. build and verify a TypeScript application;
3. create and push a public GitHub repository;
4. configure branch-based GitHub Pages without GitHub Actions;
5. wait until the public URL returns the per-run marker.

The harness observes these milestones:

- `local_repository_created`
- `application_source_created`
- `remote_repository_created`
- `main_branch_pushed`
- `pages_configured`
- `page_live`
- `agent_process_exited`

It cannot observe private model reasoning. Time outside known external phases must
be described as agent/model orchestration time, not pure "thinking time".

## Safety and external side effects

Each run creates a **public GitHub repository and a public website**. The harness:

- requires `confirmPublicRepositoryCreation: true`;
- refuses to reuse an existing repository name;
- uses a unique repository name for every run;
- never deletes repositories automatically;
- does not store configured environment variables in the result;
- does store raw agent stdout/stderr, which may still contain sensitive output and
  must be reviewed before sharing.

Run this only with a dedicated benchmark account or narrowly scoped credentials.
The generated MCP policy deliberately permits `node` and `npm run` inside the
disposable trial workspace. It is not a production policy.

## Configuration

Copy `config.example.json`, then set:

- the GitHub owner;
- an explicit, identical model for both modes;
- absolute workspace and result paths as appropriate;
- `confirmPublicRepositoryCreation` to `true` only after reviewing the effects.

The example uses Claude Code because its non-interactive mode accepts an explicit
MCP configuration file. The runner itself is agent-agnostic: `command`, `args`,
and environment can be replaced with another CLI. `{{MCP_CONFIG}}` is expanded to
the generated per-run MCP configuration.

Authenticate before running:

```bash
gh auth status
claude auth status
```

Build this MCP server, then run alternating trials to reduce cache and time-order
bias:

```bash
npm run build
node scripts/e2e-benchmark.mjs \
  --config benchmark/e2e/config.local.json \
  --mode baseline \
  --trial baseline-01
node scripts/e2e-benchmark.mjs \
  --config benchmark/e2e/config.local.json \
  --mode mcp \
  --trial mcp-01
```

Use at least five successful trials per mode for a directional result. Alternate
the order (`baseline`, `mcp`, `mcp`, `baseline`) and record cold/warm package-cache
conditions separately. GitHub Pages has external queueing and rate limits, so
avoid launching many deployments at once.

After the trials, generate the whole-task summary and graph:

```bash
npm run benchmark:e2e:report
```

This writes `benchmark/results/e2e-summary.json` and
`benchmark/results/e2e-summary.svg`.

## Metrics

The primary metric is `page_live.elapsed_ms`, with success rate reported beside
latency. Also report:

- agent-process duration;
- time to first push;
- Pages publication wait;
- retries and failed trials;
- model, effort/reasoning setting, token usage, and monetary cost when exposed by
  the selected CLI;
- component benchmark results from the same host.

Do not compare only successful latency while hiding failures. Report p50 and p95
with the number of attempted and successful trials.
