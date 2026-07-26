# End-to-end AI agent benchmark

This benchmark measures an AI agent from an empty directory to either a verified
local application or a verified public GitHub Pages deployment. It complements,
rather than replaces, the component benchmark.

## What it measures

The public task in `task.md` requires an agent to:

1. initialize a local repository;
2. build and verify a TypeScript application;
3. create and push a public GitHub repository;
4. configure branch-based GitHub Pages without GitHub Actions;
5. wait until the public URL returns the per-run marker.

The local task in `task.local.md` keeps the same application, checks, production
build, and local Git requirements, but explicitly forbids creating a remote,
running `gh`, or pushing. Its primary milestone is `agent_process_exited`; the
harness then verifies the expected local repository, source, `/docs`, `.nojekyll`,
and marker before declaring success.

The harness observes these milestones:

- `local_repository_created`
- `application_source_created`
- `remote_repository_created`
- `main_branch_pushed`
- `pages_configured`
- `page_live`
- `agent_process_exited`

For Codex runs, the example configuration starts a local OpenTelemetry receiver.
It records model/API request spans, response completion and time-to-first-token
events, reasoning-token counts, and tool results. Provider-side model compute
cannot be separated from network and queueing, so the report calls this
**model/API wall time**, not pure "thinking time".

## Safety and external side effects

Each run with `publish: true` creates a **public GitHub repository and a public
website**. The harness:

- requires `confirmPublicRepositoryCreation: true`;
- refuses to reuse an existing repository name;
- uses a unique repository name for every run;
- never deletes repositories automatically;
- does not store configured environment variables in the result;
- does store raw agent stdout/stderr, which may still contain sensitive output and
  must be reviewed before sharing.
- redacts OTel prompt, account ID, and email attributes before storing the local
  capture.

Run this only with a dedicated benchmark account or narrowly scoped credentials.
The generated MCP policy deliberately permits `node` and `npm run` inside the
disposable trial workspace. It is not a production policy.

The local configuration sets `publish: false`. It skips GitHub authentication and
remote observation entirely, creates no public resources, and uses the development
denylist policy with the trial directory as its only workspace root.

## Configuration

For the requested Codex comparison, copy `config.codex.example.json` to
`config.local.json`, then set:

- the GitHub owner;
- an explicit, identical model for both modes;
- absolute workspace and result paths as appropriate;
- `confirmPublicRepositoryCreation` to `true` only after reviewing the effects.

The Codex example fixes the model, reasoning effort, sandbox, task prompt, and
network policy across both modes. The MCP mode adds only the generated `os-batch`
server configuration. Each mode also receives a unique empty npm cache to avoid
warm-cache order bias. The generic `config.example.json` remains available for
other agent CLIs. The runner expands placeholders in arguments and environment
values, including the per-run MCP placeholders `{{MCP_CONFIG}}`,
`{{MCP_NODE}}`, `{{MCP_POLICY}}`, and `{{MCP_SERVER}}`, plus
`{{OTEL_LOGS_ENDPOINT}}`, `{{OTEL_TRACES_ENDPOINT}}`, and
`{{OTEL_METRICS_ENDPOINT}}` when `otelCapture` is enabled.

The Codex MCP examples preapprove only `os-batch.batch_exec` at the client
approval boundary. This prevents a separate auto-review model call for every
batch while the MCP server's disposable-workspace restriction and command
denylist remain authoritative. The tool still advertises
`destructiveHint: true` because policy-allowed commands can write files; changing
that hint to `false` would misdescribe the tool rather than configure approval
behavior.

For a local-only comparison, use `config.codex.local.example.json` directly:

```bash
npm run benchmark:e2e -- \
  --config benchmark/e2e/config.codex.local.example.json \
  --mode baseline \
  --trial local-controlled-baseline-01
npm run benchmark:e2e -- \
  --config benchmark/e2e/config.codex.local.example.json \
  --mode mcp \
  --trial local-controlled-mcp-01
node scripts/e2e-report.mjs \
  --results benchmark/results/e2e-local \
  --trial-label-includes local-controlled \
  --output benchmark/results/e2e-local-controlled-summary
node scripts/agent-profile.mjs \
  --results benchmark/results/e2e-local \
  --trial-label-includes local-controlled \
  --output benchmark/results/e2e-local-controlled-profile
```

These commands do not require `gh auth` and do not push.

Authenticate before running:

```bash
gh auth status
codex login status
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

For OTel-enabled Codex trials, generate the full agent profile separately:

```bash
npm run benchmark:e2e:profile -- \
  --results benchmark/results/e2e-local \
  --trial-label-includes local-controlled \
  --output benchmark/results/e2e-local-controlled-profile
```

The profile's stacked categories cover the complete agent-process wall clock:
model/API, direct commands, MCP calls, other tools, overlapping known activity,
and unattributed agent overhead. The last category is deliberately retained
instead of being mislabeled as model reasoning.

To keep pilot runs in the raw results directory while producing a controlled-only
chart, filter on the trial labels:

```bash
node scripts/e2e-report.mjs \
  --trial-label-includes controlled \
  --output benchmark/results/e2e-controlled-summary
```

## Metrics

For published runs, the primary metric is `page_live.elapsed_ms`. For local runs,
it is `agent_process_exited.elapsed_ms` after the local artifact validation passes.
Always report success rate beside latency. Also report:

- agent-process duration;
- observed CLI tool-active wall time (the union of Codex
  `command_execution`/`mcp_tool_call` intervals);
- time to first push;
- Pages publication wait;
- retries and failed trials;
- model/API active wall time, response count, time to first token,
  effort/reasoning setting, token usage, and monetary cost when exposed by the
  selected CLI;
- component benchmark results from the same host.

Do not compare only successful latency while hiding failures. Report p50 and p95
with the number of attempted and successful trials.
