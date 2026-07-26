import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { BatchExecutor } from "../dist/executor/batch-executor.js";
import { createLogger } from "../dist/observability/logger.js";

const projectRoot = process.cwd();
const resultDirectory = path.join(projectRoot, "benchmark", "results");
const fixturePath = path.join(projectRoot, "test", "fixtures", "child-process.mjs");
const nodeDirectory = path.dirname(process.execPath);

function positiveIntegerFromEnvironment(name, fallback, maximum) {
  const rawValue = process.env[name];
  if (rawValue === undefined) {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return parsed;
}

const sampleCount = positiveIntegerFromEnvironment("BENCHMARK_SAMPLES", 3, 20);
const maximumConcurrency = positiveIntegerFromEnvironment(
  "BENCHMARK_MAX_CONCURRENCY",
  16,
  16,
);
const syntheticDelayMs = positiveIntegerFromEnvironment(
  "BENCHMARK_DELAY_MS",
  100,
  10_000,
);

const policy = {
  workspaceRoots: [projectRoot],
  maxBatchSize: 16,
  maxConcurrency: 16,
  defaultConcurrency: 4,
  defaultTimeoutMs: 120_000,
  maxTimeoutMs: 120_000,
  defaultMaxOutputBytes: 256 * 1024,
  absoluteMaxOutputBytes: 1024 * 1024,
  allowedEnvironmentKeys: [],
  trustedExecutableDirectories: [nodeDirectory],
  commands: {
    node: {
      allowed: true,
      path: process.execPath,
      readOnly: true,
    },
  },
  logLevel: "silent",
  readOnly: true,
};

const nodeModules = path.join(projectRoot, "node_modules");
const verificationCommands = [
  {
    id: "format",
    argv: [
      "node",
      path.join(nodeModules, "prettier", "bin", "prettier.cjs"),
      "--check",
      ".",
    ],
  },
  {
    id: "lint",
    argv: ["node", path.join(nodeModules, "eslint", "bin", "eslint.js"), "."],
  },
  {
    id: "typecheck",
    argv: [
      "node",
      path.join(nodeModules, "typescript", "bin", "tsc"),
      "-p",
      "tsconfig.json",
      "--noEmit",
    ],
  },
  {
    id: "test",
    argv: ["node", path.join(nodeModules, "vitest", "vitest.mjs"), "run"],
  },
];

const schedulerCommands = Array.from({ length: 16 }, (_, index) => ({
  id: `delay-${index + 1}`,
  argv: ["node", fixturePath, "delay", String(syntheticDelayMs)],
}));

function percentile(values, percentileValue) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return sorted[index];
}

function orderedConcurrencies(limit, sampleIndex) {
  const values = Array.from({ length: limit }, (_, index) => index + 1);
  return sampleIndex % 2 === 0 ? values : values.reverse();
}

async function executeMeasured(executor, commands, concurrency) {
  const result = await executor.execute({
    commands,
    concurrency,
    failure_mode: "continue",
    max_output_bytes: 256 * 1024,
  });
  const failures = result.results.filter((command) => command.status !== "success");
  if (failures.length > 0) {
    const details = failures
      .map(
        (command) =>
          `${command.id}: ${command.status}: ${command.error ?? command.stderr}`,
      )
      .join("\n");
    throw new Error(`Benchmark workload failed:\n${details}`);
  }
  return result.summary.wall_time_ms;
}

async function measureWorkload(executor, commands, measuredConcurrencyLimit) {
  const samplesByConcurrency = new Map(
    Array.from({ length: measuredConcurrencyLimit }, (_, index) => [index + 1, []]),
  );

  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    for (const concurrency of orderedConcurrencies(
      measuredConcurrencyLimit,
      sampleIndex,
    )) {
      const elapsed = await executeMeasured(executor, commands, concurrency);
      samplesByConcurrency.get(concurrency).push(elapsed);
    }
  }

  const measuredPoints = Array.from(
    { length: measuredConcurrencyLimit },
    (_, index) => {
      const concurrency = index + 1;
      const samples = samplesByConcurrency.get(concurrency);
      return {
        requested_concurrency: concurrency,
        effective_concurrency: Math.min(concurrency, commands.length),
        measured: true,
        samples_ms: samples,
        p50_ms: percentile(samples, 0.5),
        p95_ms: percentile(samples, 0.95),
      };
    },
  );
  const baseline = measuredPoints[0].p50_ms;
  return measuredPoints.map((point) => ({
    ...point,
    speedup: Number((baseline / point.p50_ms).toFixed(3)),
    efficiency: Number(
      (baseline / point.p50_ms / point.effective_concurrency).toFixed(3),
    ),
  }));
}

function extendAtNaturalParallelism(points, taskCount) {
  const finalMeasuredPoint = points.at(-1);
  const baseline = points[0].p50_ms;
  const extended = [...points];
  for (
    let requestedConcurrency = points.length + 1;
    requestedConcurrency <= maximumConcurrency;
    requestedConcurrency += 1
  ) {
    extended.push({
      requested_concurrency: requestedConcurrency,
      effective_concurrency: taskCount,
      measured: false,
      inference: `No more than ${taskCount} commands can run concurrently`,
      samples_ms: [],
      p50_ms: finalMeasuredPoint.p50_ms,
      p95_ms: finalMeasuredPoint.p95_ms,
      speedup: Number((baseline / finalMeasuredPoint.p50_ms).toFixed(3)),
      efficiency: Number((baseline / finalMeasuredPoint.p50_ms / taskCount).toFixed(3)),
    });
  }
  return extended;
}

function endToEndScenarios(commandPoints) {
  const baseline = commandPoints[0].p50_ms;
  return [10, 25, 50].map((commandSharePercent) => {
    const commandShare = commandSharePercent / 100;
    return {
      command_share_percent: commandSharePercent,
      interpretation:
        "Share of the concurrency=1 end-to-end duration spent in the command phase",
      points: commandPoints.map((point) => {
        const commandRatio = point.p50_ms / baseline;
        const normalizedDuration =
          (1 - commandShare + commandShare * commandRatio) * 100;
        return {
          requested_concurrency: point.requested_concurrency,
          normalized_total_percent: Number(normalizedDuration.toFixed(2)),
          total_speedup: Number((100 / normalizedDuration).toFixed(3)),
        };
      }),
    };
  });
}

function linePath(points, xScale, yScale, valueKey) {
  return points
    .map((point, index) => {
      const prefix = index === 0 ? "M" : "L";
      return `${prefix}${xScale(point.requested_concurrency).toFixed(1)},${yScale(
        point[valueKey],
      ).toFixed(1)}`;
    })
    .join(" ");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function niceUpperBound(value) {
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const normalized = value / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function chartSvg(result) {
  const width = 1200;
  const height = 930;
  const left = 92;
  const right = 1145;
  const plotWidth = right - left;
  const firstTop = 90;
  const firstBottom = 385;
  const secondTop = 545;
  const secondBottom = 840;
  const xScale = (concurrency) =>
    left + ((concurrency - 1) / (maximumConcurrency - 1)) * plotWidth;
  const allCommandPoints = [
    ...result.workloads.scheduler.points,
    ...result.workloads.agent_verification.points,
  ];
  const maximumCommandSeconds = niceUpperBound(
    Math.max(...allCommandPoints.map((point) => point.p50_ms / 1000)) * 1.1,
  );
  const commandYScale = (milliseconds) =>
    firstBottom -
    (milliseconds / 1000 / maximumCommandSeconds) * (firstBottom - firstTop);
  const allScenarioValues = result.end_to_end_model.scenarios.flatMap((scenario) =>
    scenario.points.map((point) => point.normalized_total_percent),
  );
  const minimumTotalPercent = Math.max(
    0,
    Math.floor(Math.min(...allScenarioValues) / 5) * 5 - 5,
  );
  const totalYScale = (percent) =>
    secondBottom -
    ((percent - minimumTotalPercent) / (100 - minimumTotalPercent)) *
      (secondBottom - secondTop);
  const measuredVerification = result.workloads.agent_verification.points.filter(
    (point) => point.measured,
  );
  const inferredVerification = result.workloads.agent_verification.points.filter(
    (point) =>
      point.requested_concurrency >= measuredVerification.at(-1).requested_concurrency,
  );
  const xTicks = [1, 2, 4, 6, 8, 10, 12, 14, 16].filter(
    (value) => value <= maximumConcurrency,
  );
  const commandTicks = Array.from({ length: 6 }, (_, index) =>
    Math.round((maximumCommandSeconds / 5) * index),
  );
  const totalTickStep = 5;
  const totalTicks = Array.from(
    { length: (100 - minimumTotalPercent) / totalTickStep + 1 },
    (_, index) => minimumTotalPercent + totalTickStep * index,
  );
  const scenarioColours = ["#16a34a", "#7c3aed", "#dc2626"];
  const generatedLabel = new Date(result.generated_at).toISOString();

  const horizontalGrid = (ticks, yScale, formatter) =>
    ticks
      .map(
        (tick) => `
      <line class="grid" x1="${left}" x2="${right}" y1="${yScale(
        formatter.toValue(tick),
      )}" y2="${yScale(formatter.toValue(tick))}" />
      <text class="tick" x="${left - 14}" y="${
        yScale(formatter.toValue(tick)) + 5
      }" text-anchor="end">${escapeXml(formatter.toLabel(tick))}</text>`,
      )
      .join("");
  const xAxis = (bottom) =>
    xTicks
      .map(
        (tick) => `
      <line class="grid vertical" x1="${xScale(tick)}" x2="${xScale(
        tick,
      )}" y1="${bottom - 295}" y2="${bottom}" />
      <text class="tick" x="${xScale(tick)}" y="${
        bottom + 25
      }" text-anchor="middle">${tick}</text>`,
      )
      .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">os-batch-mcp component benchmark</title>
  <desc id="description">Command-only completion time from concurrency one to sixteen, followed by normalized end-to-end duration scenarios where commands occupy ten, twenty-five, or fifty percent of the original task.</desc>
  <style>
    text { font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; fill: #172033; }
    .title { font-size: 22px; font-weight: 600; }
    .subtitle { font-size: 14px; fill: #536075; }
    .axis-label { font-size: 14px; font-weight: 600; }
    .tick { font-size: 12px; fill: #5d687a; }
    .grid { stroke: #d7dde7; stroke-width: 1; }
    .grid.vertical { stroke: #edf0f5; }
    .line { fill: none; stroke-width: 3; stroke-linejoin: round; stroke-linecap: round; }
    .point { stroke: #ffffff; stroke-width: 2; }
    .legend { font-size: 13px; }
    .note { font-size: 12px; fill: #5d687a; }
    @media (prefers-color-scheme: dark) {
      text { fill: #eef2f8; }
      .subtitle, .tick, .note { fill: #aab4c5; }
      .grid { stroke: #455065; }
      .grid.vertical { stroke: #2f394b; }
      .point { stroke: #151b28; }
    }
  </style>
  <text class="title" x="${left}" y="36">Command phase: measured wall time</text>
  <text class="subtitle" x="${left}" y="60">p50 of ${sampleCount} samples; scheduler uses 16 × ${syntheticDelayMs} ms processes, verification uses format + lint + typecheck + test</text>
  ${horizontalGrid(commandTicks, commandYScale, {
    toValue: (value) => value * 1000,
    toLabel: (value) => `${value}s`,
  })}
  ${xAxis(firstBottom)}
  <text class="axis-label" x="${(left + right) / 2}" y="${
    firstBottom + 52
  }" text-anchor="middle">Requested concurrency</text>
  <path class="line" stroke="#2563eb" d="${linePath(
    result.workloads.scheduler.points,
    xScale,
    commandYScale,
    "p50_ms",
  )}" />
  ${result.workloads.scheduler.points
    .map(
      (point) =>
        `<circle class="point" fill="#2563eb" cx="${xScale(
          point.requested_concurrency,
        )}" cy="${commandYScale(point.p50_ms)}" r="4" />`,
    )
    .join("")}
  <path class="line" stroke="#ea580c" d="${linePath(
    measuredVerification,
    xScale,
    commandYScale,
    "p50_ms",
  )}" />
  <path class="line" stroke="#ea580c" stroke-dasharray="8 7" d="${linePath(
    inferredVerification,
    xScale,
    commandYScale,
    "p50_ms",
  )}" />
  ${measuredVerification
    .map(
      (point) =>
        `<circle class="point" fill="#ea580c" cx="${xScale(
          point.requested_concurrency,
        )}" cy="${commandYScale(point.p50_ms)}" r="5" />`,
    )
    .join("")}
  <line x1="${left + 660}" x2="${left + 700}" y1="100" y2="100" stroke="#2563eb" stroke-width="3" />
  <text class="legend" x="${left + 712}" y="105">Scheduler workload (16 tasks)</text>
  <line x1="${left + 660}" x2="${left + 700}" y1="127" y2="127" stroke="#ea580c" stroke-width="3" />
  <text class="legend" x="${left + 712}" y="132">Agent verification (4 natural tasks)</text>
  <text class="note" x="${xScale(4) + 12}" y="${
    commandYScale(measuredVerification.at(-1).p50_ms) - 12
  }">Dashed after 4: inferred plateau, not extra measurements</text>

  <text class="title" x="${left}" y="478">Whole task: command share scenarios</text>
  <text class="subtitle" x="${left}" y="502">Amdahl model using the measured verification curve; 100% is the concurrency=1 end-to-end duration</text>
  ${horizontalGrid(totalTicks, totalYScale, {
    toValue: (value) => value,
    toLabel: (value) => `${Math.round(value)}%`,
  })}
  ${xAxis(secondBottom)}
  <text class="axis-label" x="${(left + right) / 2}" y="${
    secondBottom + 52
  }" text-anchor="middle">Requested concurrency</text>
  ${result.end_to_end_model.scenarios
    .map(
      (scenario, index) => `
  <path class="line" stroke="${scenarioColours[index]}" d="${linePath(
    scenario.points,
    xScale,
    totalYScale,
    "normalized_total_percent",
  )}" />
  ${scenario.points
    .filter((point) => [1, 2, 4, 8, 16].includes(point.requested_concurrency))
    .map(
      (point) =>
        `<circle class="point" fill="${
          scenarioColours[index]
        }" cx="${xScale(point.requested_concurrency)}" cy="${totalYScale(
          point.normalized_total_percent,
        )}" r="4" />`,
    )
    .join("")}`,
    )
    .join("")}
  ${result.end_to_end_model.scenarios
    .map(
      (scenario, index) => `
  <line x1="${left + 660}" x2="${left + 700}" y1="${
    secondTop + 10 + index * 27
  }" y2="${secondTop + 10 + index * 27}" stroke="${
    scenarioColours[index]
  }" stroke-width="3" />
  <text class="legend" x="${left + 712}" y="${
    secondTop + 15 + index * 27
  }">Commands are ${scenario.command_share_percent}% of baseline total</text>`,
    )
    .join("")}
  <text class="note" x="${right}" y="${height - 10}" text-anchor="end">Generated ${escapeXml(
    generatedLabel,
  )} on ${escapeXml(result.host.platform)} ${escapeXml(result.host.arch)}, Node ${escapeXml(
    result.host.node,
  )}</text>
</svg>
`;
  return svg.replaceAll(/[ \t]+\n/g, "\n");
}

async function renderExistingResult() {
  const jsonPath = path.join(resultDirectory, "component-latest.json");
  const svgPath = path.join(resultDirectory, "component-latest.svg");
  const result = JSON.parse(await readFile(jsonPath, "utf8"));
  await writeFile(svgPath, chartSvg(result), "utf8");
  process.stdout.write(`chart=${path.relative(projectRoot, svgPath)}\n`);
}

async function runMeasurements() {
  const executor = new BatchExecutor(policy, createLogger("silent"));
  try {
    process.stdout.write(
      `Measuring scheduler workload (${sampleCount} samples, concurrency 1-${maximumConcurrency})...\n`,
    );
    const schedulerPoints = await measureWorkload(
      executor,
      schedulerCommands,
      maximumConcurrency,
    );

    const naturalVerificationConcurrency = Math.min(
      verificationCommands.length,
      maximumConcurrency,
    );
    process.stdout.write(
      `Measuring agent verification workload (${sampleCount} samples, concurrency 1-${naturalVerificationConcurrency})...\n`,
    );
    const measuredVerificationPoints = await measureWorkload(
      executor,
      verificationCommands,
      naturalVerificationConcurrency,
    );
    const verificationPoints = extendAtNaturalParallelism(
      measuredVerificationPoints,
      verificationCommands.length,
    );

    const result = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      host: {
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpu_count: os.availableParallelism(),
        node: process.version,
      },
      configuration: {
        samples: sampleCount,
        maximum_concurrency: maximumConcurrency,
        synthetic_delay_ms: syntheticDelayMs,
      },
      workloads: {
        scheduler: {
          kind: "synthetic_scheduler",
          description:
            "Sixteen independent Node processes that each wait for a fixed duration",
          task_count: schedulerCommands.length,
          points: schedulerPoints,
        },
        agent_verification: {
          kind: "real_project_verification",
          description:
            "Four natural post-edit checks: Prettier, ESLint, TypeScript, and Vitest",
          task_count: verificationCommands.length,
          tasks: verificationCommands.map((command) => command.id),
          inference_note:
            "Concurrency above four is a logical plateau because only four independent commands exist",
          points: verificationPoints,
        },
      },
      end_to_end_model: {
        kind: "amdahl_scenarios",
        description:
          "Normalized whole-task duration derived from the measured verification curve; this is a model, not observed AI reasoning time",
        formula:
          "total(c) = (1 - command_share) + command_share * command_time(c) / command_time(1)",
        scenarios: endToEndScenarios(verificationPoints),
      },
    };

    await mkdir(resultDirectory, { recursive: true });
    const jsonPath = path.join(resultDirectory, "component-latest.json");
    const svgPath = path.join(resultDirectory, "component-latest.svg");
    await Promise.all([
      writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`, "utf8"),
      writeFile(svgPath, chartSvg(result), "utf8"),
    ]);

    const schedulerFinal = schedulerPoints.at(-1);
    const verificationFinal = measuredVerificationPoints.at(-1);
    process.stdout.write(
      `scheduler_p50_ms: c1=${schedulerPoints[0].p50_ms}, c${maximumConcurrency}=${schedulerFinal.p50_ms}, speedup=${schedulerFinal.speedup}\n`,
    );
    process.stdout.write(
      `verification_p50_ms: c1=${measuredVerificationPoints[0].p50_ms}, c${naturalVerificationConcurrency}=${verificationFinal.p50_ms}, speedup=${verificationFinal.speedup}\n`,
    );
    process.stdout.write(`results=${path.relative(projectRoot, jsonPath)}\n`);
    process.stdout.write(`chart=${path.relative(projectRoot, svgPath)}\n`);
  } finally {
    await executor.shutdown();
  }
}

if (process.argv.includes("--render-only")) {
  await renderExistingResult();
} else {
  await runMeasurements();
}
