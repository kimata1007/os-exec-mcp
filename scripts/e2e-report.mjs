import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function parseArguments(arguments_) {
  const parsed = {
    results: path.resolve("benchmark", "results", "e2e"),
    output: path.resolve("benchmark", "results", "e2e-summary"),
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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadResults(resultDirectory) {
  let entries;
  try {
    entries = await readdir(resultDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  const results = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const resultPath = path.join(resultDirectory, entry.name, "result.json");
    try {
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      if (result.benchmark === "repository-to-github-pages") {
        results.push(result);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Cannot read ${resultPath}: ${error.message}`, {
          cause: error,
        });
      }
    }
  }
  return results.sort((left, right) => left.started_at.localeCompare(right.started_at));
}

function phaseTime(result, phaseName) {
  return result.phases?.[phaseName]?.elapsed_ms ?? null;
}

function summarize(results) {
  const modes = new Map();
  for (const result of results) {
    const existing = modes.get(result.mode) ?? {
      mode: result.mode,
      label: result.mode_label,
      attempted: 0,
      succeeded: 0,
      totalTimes: [],
      pagesWaitTimes: [],
      toolActiveTimes: [],
    };
    existing.attempted += 1;
    const pageLive = phaseTime(result, "page_live");
    const pagesConfigured = phaseTime(result, "pages_configured");
    if (result.success && pageLive !== null) {
      existing.succeeded += 1;
      existing.totalTimes.push(pageLive);
      if (pagesConfigured !== null) {
        existing.pagesWaitTimes.push(Math.max(0, pageLive - pagesConfigured));
      }
      const toolActive = result.agent?.telemetry?.combined_wall_time_union_ms ?? null;
      if (typeof toolActive === "number") {
        existing.toolActiveTimes.push(toolActive);
      }
    }
    modes.set(result.mode, existing);
  }
  return [...modes.values()].map((mode) => ({
    mode: mode.mode,
    label: mode.label,
    attempted: mode.attempted,
    succeeded: mode.succeeded,
    success_rate: Number((mode.succeeded / mode.attempted).toFixed(3)),
    total_time_ms: {
      p50: percentile(mode.totalTimes, 0.5),
      p95: percentile(mode.totalTimes, 0.95),
    },
    pages_wait_ms: {
      p50: percentile(mode.pagesWaitTimes, 0.5),
      p95: percentile(mode.pagesWaitTimes, 0.95),
    },
    tool_active_wall_time_ms: {
      p50: percentile(mode.toolActiveTimes, 0.5),
      p95: percentile(mode.toolActiveTimes, 0.95),
    },
  }));
}

function resultSvg(results, summary) {
  const width = 1200;
  const rowHeight = 60;
  const top = 130;
  const bottomPadding = 80;
  const height = Math.max(430, top + results.length * rowHeight + bottomPadding);
  const left = 260;
  const right = 1135;
  const plotWidth = right - left;
  const maximumMilliseconds = Math.max(
    ...results.map((result) =>
      Math.max(
        phaseTime(result, "page_live") ?? 0,
        phaseTime(result, "agent_process_exited") ?? 0,
      ),
    ),
  );
  const roundedMaximumMinutes = Math.max(1, Math.ceil(maximumMilliseconds / 60_000));
  const xScale = (milliseconds) =>
    left +
    (Math.min(milliseconds, roundedMaximumMinutes * 60_000) /
      (roundedMaximumMinutes * 60_000)) *
      plotWidth;
  const modeNames = [...new Set(results.map((result) => result.mode))];
  const modeColours = new Map(
    modeNames.map((mode, index) => [
      mode,
      ["#2563eb", "#7c3aed", "#16a34a", "#dc2626"][index % 4],
    ]),
  );
  const tickCount = Math.min(7, roundedMaximumMinutes + 1);
  const ticks = Array.from(
    { length: tickCount },
    (_, index) => (roundedMaximumMinutes / Math.max(1, tickCount - 1)) * index,
  );

  const rows = results
    .map((result, index) => {
      const y = top + index * rowHeight;
      const pageLive = phaseTime(result, "page_live");
      const pagesConfigured = phaseTime(result, "pages_configured");
      const total = pageLive ?? result.elapsed_ms;
      const beforePages =
        pagesConfigured === null ? total : Math.min(total, pagesConfigured);
      const pagesWait = Math.max(0, total - beforePages);
      const agentExit = phaseTime(result, "agent_process_exited");
      const toolActive = result.agent?.telemetry?.combined_wall_time_union_ms ?? null;
      const colour = modeColours.get(result.mode);
      const failureLabel = result.success ? "" : " (failed)";
      return `
    <text class="row-label" x="${left - 14}" y="${
      y + 18
    }" text-anchor="end">${escapeXml(result.trial_label)}${failureLabel}</text>
    <rect x="${left}" y="${y}" width="${
      xScale(beforePages) - left
    }" height="24" fill="${result.success ? colour : "#6b7280"}" opacity="0.9" />
    <rect x="${xScale(beforePages)}" y="${y}" width="${
      xScale(pagesWait) - left
    }" height="24" fill="${result.success ? colour : "#6b7280"}" opacity="0.35" />
    ${
      typeof toolActive === "number"
        ? `<rect x="${left}" y="${y + 30}" width="${
            xScale(toolActive) - left
          }" height="8" fill="#f59e0b" rx="4" />
    <text class="tool-value" x="${Math.min(
      right - 4,
      xScale(toolActive) + 8,
    )}" y="${y + 39}">tools ${(toolActive / 60_000).toFixed(2)} min</text>`
        : ""
    }
    ${
      agentExit === null
        ? ""
        : `<path d="M${xScale(agentExit)},${y - 3} V${
            y + 27
          }" stroke="currentColor" stroke-width="2" />`
    }
    <text class="value" x="${Math.min(right - 4, xScale(total) + 8)}" y="${
      y + 18
    }">${(total / 60_000).toFixed(2)} min</text>`;
    })
    .join("");

  const summaryText = summary
    .map(
      (mode, index) =>
        `<text class="summary" x="${left + index * 330}" y="78">${escapeXml(
          mode.label,
        )}: ${mode.succeeded}/${mode.attempted} success, p50 ${
          mode.total_time_ms.p50 === null
            ? "n/a"
            : `${(mode.total_time_ms.p50 / 60_000).toFixed(2)} min`
        }</text>`,
    )
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Repository-to-GitHub-Pages benchmark</title>
  <desc id="description">End-to-end duration for each AI agent trial. Solid bars show time through Pages configuration, translucent bars show publication wait, orange bars show observed tool-active wall time, and vertical markers show agent exit.</desc>
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #172033; }
    .title { font-size: 22px; font-weight: 600; }
    .subtitle, .summary { font-size: 13px; fill: #536075; }
    .row-label, .value, .tool-value { font-size: 12px; }
    .tool-value { fill: #8a5600; }
    .axis { font-size: 12px; fill: #5d687a; }
    .grid { stroke: #d7dde7; stroke-width: 1; }
    @media (prefers-color-scheme: dark) {
      text { fill: #eef2f8; }
      .subtitle, .summary, .axis { fill: #aab4c5; }
      .tool-value { fill: #fbbf24; }
      .grid { stroke: #455065; }
    }
  </style>
  <text class="title" x="${left}" y="34">Whole task: empty directory to live GitHub Pages URL</text>
  <text class="subtitle" x="${left}" y="56">Solid: through Pages configuration · translucent: publication wait · orange: observed tool-active time · marker: agent exit</text>
  ${summaryText}
  ${ticks
    .map(
      (tick) => `
    <line class="grid" x1="${xScale(tick * 60_000)}" x2="${xScale(
      tick * 60_000,
    )}" y1="${top - 18}" y2="${height - bottomPadding + 8}" />
    <text class="axis" x="${xScale(tick * 60_000)}" y="${
      height - bottomPadding + 30
    }" text-anchor="middle">${tick.toFixed(1)} min</text>`,
    )
    .join("")}
  ${rows}
</svg>
`;
  return svg.replaceAll(/[ \t]+\n/g, "\n");
}

const arguments_ = parseArguments(process.argv.slice(2));
const loadedResults = await loadResults(arguments_.results);
const results =
  arguments_.trialLabelIncludes === null
    ? loadedResults
    : loadedResults.filter((result) =>
        result.trial_label.includes(arguments_.trialLabelIncludes),
      );
if (results.length === 0) {
  throw new Error(
    `No matching end-to-end result.json files found under ${arguments_.results}`,
  );
}
const modes = summarize(results);
const summary = {
  schema_version: 1,
  benchmark: "repository-to-github-pages-summary",
  generated_at: new Date().toISOString(),
  attempted_trials: results.length,
  trial_label_includes: arguments_.trialLabelIncludes,
  modes,
  cautions: [
    "Latency includes model, local commands, GitHub API/network, and Pages queueing.",
    "AI reasoning is not directly observable.",
    "Success rate must be reported with latency.",
  ],
};
await Promise.all([
  writeFile(
    `${arguments_.output}.json`,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  ),
  writeFile(`${arguments_.output}.svg`, resultSvg(results, modes), "utf8"),
]);
process.stdout.write(`summary=${arguments_.output}.json\n`);
process.stdout.write(`chart=${arguments_.output}.svg\n`);
