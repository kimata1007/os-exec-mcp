import { createReadStream } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";

const CATEGORY_ORDER = [
  "model_api",
  "command",
  "mcp",
  "other_tool",
  "known_overlap",
  "unattributed",
];
const CATEGORY_LABELS = {
  model_api: "Model/API",
  command: "Commands",
  mcp: "MCP",
  other_tool: "Other tools",
  known_overlap: "Concurrent known work",
  unattributed: "Agent overhead / unattributed",
};
const CATEGORY_COLOURS = {
  model_api: "#2563eb",
  command: "#16a34a",
  mcp: "#7c3aed",
  other_tool: "#f59e0b",
  known_overlap: "#dc2626",
  unattributed: "#94a3b8",
};

function parseArguments(arguments_) {
  const parsed = {
    results: path.resolve("benchmark", "results", "e2e-local"),
    output: path.resolve("benchmark", "results", "e2e-agent-profile"),
    trialLabelIncludes: null,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (
      argument !== "--results" &&
      argument !== "--output" &&
      argument !== "--trial-label-includes"
    ) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--trial-label-includes") {
      parsed.trialLabelIncludes = value;
    } else {
      parsed[argument.slice(2)] = path.resolve(value);
    }
    index += 1;
  }
  return parsed;
}

function otelValue(value) {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  for (const key of [
    "stringValue",
    "intValue",
    "doubleValue",
    "boolValue",
    "bytesValue",
  ]) {
    if (value[key] !== undefined) {
      return value[key];
    }
  }
  return undefined;
}

function attributesMap(attributes) {
  return Object.fromEntries(
    (attributes ?? []).map((attribute) => [attribute.key, otelValue(attribute.value)]),
  );
}

function nanosecondsToMilliseconds(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    return null;
  }
  return Number(BigInt(value) / 1_000_000n);
}

function eventMilliseconds(record, attributes) {
  const timestamp = attributes["event.timestamp"];
  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return nanosecondsToMilliseconds(record.observedTimeUnixNano);
}

function durationMilliseconds(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function classifyTool(toolName) {
  const normalized = String(toolName ?? "").toLowerCase();
  if (
    normalized.includes("mcp") ||
    normalized.includes("batch_exec") ||
    normalized.includes("os-batch")
  ) {
    return "mcp";
  }
  if (
    normalized.includes("exec") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command";
  }
  return "other_tool";
}

function addEventInterval(target, record, attributes, startedAt) {
  const duration = durationMilliseconds(attributes.duration_ms);
  const endedAt = eventMilliseconds(record, attributes);
  if (duration === null || endedAt === null) {
    return;
  }
  target.push({
    start: endedAt - duration - startedAt,
    end: endedAt - startedAt,
  });
}

async function readOtelCapture(capturePath, startedAt) {
  const telemetry = {
    modelIntervals: [],
    toolIntervals: {
      command: [],
      mcp: [],
      other_tool: [],
    },
    toolCounts: {
      command: 0,
      mcp: 0,
      other_tool: 0,
    },
    responseCompletions: [],
    turnTtft: [],
  };
  const lines = createInterface({
    input: createReadStream(capturePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }
    const request = JSON.parse(line);
    for (const resourceLogs of request.body?.resourceLogs ?? []) {
      for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
        for (const record of scopeLogs.logRecords ?? []) {
          const attributes = attributesMap(record.attributes);
          const eventName = attributes["event.name"];
          if (
            eventName === "codex.api_request" ||
            eventName === "codex.websocket_connect"
          ) {
            addEventInterval(telemetry.modelIntervals, record, attributes, startedAt);
          }
          if (eventName === "codex.tool_result") {
            const category = classifyTool(attributes.tool_name);
            addEventInterval(
              telemetry.toolIntervals[category],
              record,
              attributes,
              startedAt,
            );
            telemetry.toolCounts[category] += 1;
          }
          if (
            eventName === "codex.sse_event" &&
            attributes["event.kind"] === "response.completed"
          ) {
            telemetry.responseCompletions.push({
              model: attributes.model ?? null,
              input_tokens: Number(attributes.input_token_count ?? 0),
              cached_tokens: Number(attributes.cached_token_count ?? 0),
              output_tokens: Number(attributes.output_token_count ?? 0),
              reasoning_tokens: Number(attributes.reasoning_token_count ?? 0),
              ttft_ms: durationMilliseconds(attributes.ttft_ms),
            });
          }
          if (eventName === "codex.turn_ttft") {
            const duration = durationMilliseconds(attributes.duration_ms);
            if (duration !== null) {
              telemetry.turnTtft.push(duration);
            }
          }
        }
      }
    }
    for (const resourceSpans of request.body?.resourceSpans ?? []) {
      for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
        for (const span of scopeSpans.spans ?? []) {
          const isModelStream =
            span.name === "responses_websocket.stream_request" ||
            span.name === "responses_sse.stream_request" ||
            (/responses.*\.stream_request$/.test(span.name) &&
              !span.name.startsWith("model_client."));
          const isModelConnection =
            span.name === "responses_websocket.connect" ||
            span.name === "responses_sse.connect";
          if (!isModelStream && !isModelConnection) {
            continue;
          }
          const start = nanosecondsToMilliseconds(span.startTimeUnixNano);
          const end = nanosecondsToMilliseconds(span.endTimeUnixNano);
          if (start !== null && end !== null && end >= start) {
            telemetry.modelIntervals.push({
              start: start - startedAt,
              end: end - startedAt,
            });
          }
        }
      }
    }
  }
  return telemetry;
}

function clipIntervals(intervals, total) {
  return intervals
    .map((interval) => ({
      start: Math.max(0, Math.min(total, Number(interval.start))),
      end: Math.max(0, Math.min(total, Number(interval.end))),
    }))
    .filter(
      (interval) =>
        Number.isFinite(interval.start) &&
        Number.isFinite(interval.end) &&
        interval.end > interval.start,
    );
}

function intervalUnionMilliseconds(intervals) {
  if (intervals.length === 0) {
    return 0;
  }
  const sorted = [...intervals].sort((left, right) => left.start - right.start);
  let total = 0;
  let currentStart = sorted[0].start;
  let currentEnd = sorted[0].end;
  for (const interval of sorted.slice(1)) {
    if (interval.start <= currentEnd) {
      currentEnd = Math.max(currentEnd, interval.end);
      continue;
    }
    total += currentEnd - currentStart;
    currentStart = interval.start;
    currentEnd = interval.end;
  }
  return total + currentEnd - currentStart;
}

function partitionTimeline(intervalsByCategory, total) {
  const knownCategories = ["model_api", "command", "mcp", "other_tool"];
  const boundaries = new Set([0, total]);
  for (const category of knownCategories) {
    for (const interval of intervalsByCategory[category]) {
      boundaries.add(interval.start);
      boundaries.add(interval.end);
    }
  }
  const sorted = [...boundaries].sort((left, right) => left - right);
  const breakdown = Object.fromEntries(CATEGORY_ORDER.map((category) => [category, 0]));
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const start = sorted[index];
    const end = sorted[index + 1];
    const midpoint = start + (end - start) / 2;
    const active = knownCategories.filter((category) =>
      intervalsByCategory[category].some(
        (interval) => interval.start <= midpoint && interval.end >= midpoint,
      ),
    );
    const category =
      active.length === 0
        ? "unattributed"
        : active.length === 1
          ? active[0]
          : "known_overlap";
    breakdown[category] += end - start;
  }
  return Object.fromEntries(
    Object.entries(breakdown).map(([category, value]) => [category, Math.round(value)]),
  );
}

function percentile(values, percentileValue) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index];
}

function countsByModel(completions) {
  const counts = new Map();
  for (const completion of completions) {
    const model = completion.model ?? "unknown";
    counts.set(model, (counts.get(model) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort());
}

async function loadResults(resultDirectory) {
  const entries = await readdir(resultDirectory, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const resultPath = path.join(resultDirectory, entry.name, "result.json");
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      if (typeof result.artifacts?.otel_capture === "string") {
        results.push({
          directory: path.dirname(resultPath),
          result,
        });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return results.sort((left, right) =>
    left.result.started_at.localeCompare(right.result.started_at),
  );
}

function resolveCapturePath(loaded) {
  const configured = loaded.result.artifacts.otel_capture;
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.resolve(loaded.directory, configured);
}

async function profileTrial(loaded) {
  const result = loaded.result;
  const startedAt = Date.parse(result.started_at);
  const totalWall =
    result.phases?.agent_process_exited?.elapsed_ms ?? result.elapsed_ms;
  const otel = await readOtelCapture(resolveCapturePath(loaded), startedAt);
  const cliIntervals = result.agent?.telemetry?.intervals ?? {};
  const commandIntervals = clipIntervals(
    cliIntervals.command_execution?.length > 0
      ? cliIntervals.command_execution
      : otel.toolIntervals.command,
    totalWall,
  );
  const mcpIntervals = clipIntervals(
    cliIntervals.mcp_tool_call?.length > 0
      ? cliIntervals.mcp_tool_call
      : otel.toolIntervals.mcp,
    totalWall,
  );
  const intervals = {
    model_api: clipIntervals(otel.modelIntervals, totalWall),
    command: commandIntervals,
    mcp: mcpIntervals,
    other_tool: clipIntervals(otel.toolIntervals.other_tool, totalWall),
  };
  const knownIntervals = Object.values(intervals).flat();
  const toolIntervals = [
    ...intervals.command,
    ...intervals.mcp,
    ...intervals.other_tool,
  ];
  const breakdown = partitionTimeline(intervals, totalWall);
  const percentages = Object.fromEntries(
    CATEGORY_ORDER.map((category) => [
      category,
      Number(((breakdown[category] / totalWall) * 100).toFixed(1)),
    ]),
  );
  const usage = result.agent?.telemetry?.usage ?? null;
  return {
    run_id: result.run_id,
    trial_label: result.trial_label,
    mode: result.mode,
    mode_label: result.mode_label,
    success: result.success,
    total_wall_ms: totalWall,
    breakdown_ms: breakdown,
    breakdown_percent: percentages,
    active_wall_ms: {
      model_api_union: Math.round(intervalUnionMilliseconds(intervals.model_api)),
      tools_union: Math.round(intervalUnionMilliseconds(toolIntervals)),
      all_known_union: Math.round(intervalUnionMilliseconds(knownIntervals)),
    },
    model: {
      response_count: otel.responseCompletions.length,
      response_count_by_model: countsByModel(otel.responseCompletions),
      response_completed: otel.responseCompletions,
      turn_ttft_ms: {
        p50: percentile(otel.turnTtft, 0.5),
        p95: percentile(otel.turnTtft, 0.95),
      },
      usage,
    },
    tools: {
      command_completed:
        result.agent?.telemetry?.command_execution?.completed ??
        otel.toolCounts.command,
      mcp_completed:
        result.agent?.telemetry?.mcp_tool_call?.completed ?? otel.toolCounts.mcp,
      other_completed: otel.toolCounts.other_tool,
    },
    sources: {
      result: path.relative(process.cwd(), path.join(loaded.directory, "result.json")),
      otel_capture: path.relative(process.cwd(), resolveCapturePath(loaded)),
    },
  };
}

function summarizeModes(trials) {
  const modes = new Map();
  for (const trial of trials) {
    const mode = modes.get(trial.mode) ?? {
      mode: trial.mode,
      label: trial.mode_label,
      total: [],
      model: [],
      tools: [],
      unattributed: [],
    };
    mode.total.push(trial.total_wall_ms);
    mode.model.push(trial.active_wall_ms.model_api_union);
    mode.tools.push(trial.active_wall_ms.tools_union);
    mode.unattributed.push(trial.breakdown_ms.unattributed);
    modes.set(trial.mode, mode);
  }
  return [...modes.values()].map((mode) => ({
    mode: mode.mode,
    label: mode.label,
    trials: mode.total.length,
    p50_ms: {
      total: percentile(mode.total, 0.5),
      model_api_active: percentile(mode.model, 0.5),
      tools_active: percentile(mode.tools, 0.5),
      unattributed: percentile(mode.unattributed, 0.5),
    },
  }));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function profileSvg(trials) {
  const width = 1280;
  const left = 270;
  const right = 1190;
  const plotWidth = right - left;
  const top = 175;
  const rowHeight = 96;
  const height = Math.max(460, top + trials.length * rowHeight + 95);
  const maximum = Math.max(...trials.map((trial) => trial.total_wall_ms));
  const roundedMaximumSeconds = Math.max(10, Math.ceil(maximum / 30_000) * 30);
  const xScale = (milliseconds) =>
    left + (milliseconds / (roundedMaximumSeconds * 1000)) * plotWidth;
  const tickCount = 7;
  const ticks = Array.from(
    { length: tickCount },
    (_, index) => (roundedMaximumSeconds / (tickCount - 1)) * index,
  );
  const legend = CATEGORY_ORDER.map((category, index) => {
    const x = left + (index % 3) * 285;
    const y = 82 + Math.floor(index / 3) * 24;
    return `<rect x="${x}" y="${y - 12}" width="13" height="13" rx="2" fill="${CATEGORY_COLOURS[category]}" />
  <text class="legend" x="${x + 20}" y="${y}">${CATEGORY_LABELS[category]}</text>`;
  }).join("\n  ");
  const rows = trials
    .map((trial, index) => {
      const y = top + index * rowHeight;
      let cursor = 0;
      const segments = CATEGORY_ORDER.map((category) => {
        const value = trial.breakdown_ms[category];
        const start = cursor;
        cursor += value;
        return `<rect x="${xScale(start)}" y="${y}" width="${Math.max(
          0,
          xScale(value) - left,
        )}" height="34" fill="${CATEGORY_COLOURS[category]}" />`;
      }).join("\n    ");
      const modelPercent = (
        (trial.active_wall_ms.model_api_union / trial.total_wall_ms) *
        100
      ).toFixed(1);
      const toolPercent = (
        (trial.active_wall_ms.tools_union / trial.total_wall_ms) *
        100
      ).toFixed(1);
      const reasoning = trial.model.usage?.reasoning_output_tokens;
      return `<text class="row-label" x="${left - 14}" y="${
        y + 22
      }" text-anchor="end">${escapeXml(trial.trial_label)}</text>
    ${segments}
    <text class="value" x="${Math.min(
      right - 4,
      xScale(trial.total_wall_ms) + 8,
    )}" y="${y + 22}">${(trial.total_wall_ms / 1000).toFixed(1)} s</text>
    <text class="detail" x="${left}" y="${y + 57}">Model/API active ${(
      trial.active_wall_ms.model_api_union / 1000
    ).toFixed(1)} s (${modelPercent}%) · tools ${(
      trial.active_wall_ms.tools_union / 1000
    ).toFixed(1)} s (${toolPercent}%) · reasoning tokens ${reasoning ?? "n/a"}</text>`;
    })
    .join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Whole AI agent profile</title>
  <desc id="description">Stacked whole-task wall time including model API, tools, overlap, and unattributed agent overhead.</desc>
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #172033; }
    .title { font-size: 24px; font-weight: 650; }
    .subtitle, .legend, .detail, .axis { font-size: 13px; fill: #536075; }
    .row-label, .value { font-size: 13px; }
    .grid { stroke: #d7dde7; stroke-width: 1; }
    @media (prefers-color-scheme: dark) {
      text { fill: #eef2f8; }
      .subtitle, .legend, .detail, .axis { fill: #aab4c5; }
      .grid { stroke: #455065; }
    }
  </style>
  <text class="title" x="${left}" y="34">Whole AI agent profile: standard Codex vs Codex + MCP</text>
  <text class="subtitle" x="${left}" y="58">Model/API includes provider generation, network and queueing; private server compute cannot be isolated.</text>
  ${legend}
  ${ticks
    .map(
      (tick) => `<line class="grid" x1="${xScale(tick * 1000)}" x2="${xScale(
        tick * 1000,
      )}" y1="${top - 18}" y2="${height - 70}" />
  <text class="axis" x="${xScale(tick * 1000)}" y="${
    height - 42
  }" text-anchor="middle">${tick.toFixed(0)} s</text>`,
    )
    .join("\n  ")}
  ${rows}
</svg>
`;
}

const arguments_ = parseArguments(process.argv.slice(2));
const loadedResults = await loadResults(arguments_.results);
const selected =
  arguments_.trialLabelIncludes === null
    ? loadedResults
    : loadedResults.filter((loaded) =>
        loaded.result.trial_label.includes(arguments_.trialLabelIncludes),
      );
if (selected.length === 0) {
  throw new Error(
    `No OTel-enabled result.json files found under ${arguments_.results}`,
  );
}
const trials = [];
for (const loaded of selected) {
  trials.push(await profileTrial(loaded));
}
const output = {
  schema_version: 1,
  benchmark: "whole-ai-agent-profile",
  generated_at: new Date().toISOString(),
  measurement: {
    total: "wall clock from benchmark process start through Codex agent process exit",
    model_api:
      "OpenTelemetry union of Codex response streams, model connections, and API requests; includes provider generation, network, and queueing",
    tools:
      "wall-clock union of Codex CLI item intervals and OTel tool-result durations",
    unattributed:
      "remaining wall clock; includes Codex orchestration, local processing, event gaps, and any activity without a supported timing event",
    limitation:
      "provider-side private reasoning compute cannot be separated from network and queueing; reasoning token counts are reported separately",
  },
  trial_label_includes: arguments_.trialLabelIncludes,
  trials,
  modes: summarizeModes(trials),
};
await Promise.all([
  writeFile(
    `${arguments_.output}.json`,
    `${JSON.stringify(output, null, 2)}\n`,
    "utf8",
  ),
  writeFile(`${arguments_.output}.svg`, profileSvg(trials), "utf8"),
]);
process.stdout.write(`profile=${arguments_.output}.json\n`);
process.stdout.write(`chart=${arguments_.output}.svg\n`);
