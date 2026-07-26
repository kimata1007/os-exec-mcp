import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/observability/logger.js";

describe("structured logger", () => {
  it("emits newline-independent JSON through the configured stderr-style sink", () => {
    const lines: string[] = [];
    const logger = createLogger("info", (line) => {
      lines.push(line);
    });

    logger.info("batch_finished", {
      request_id: "request",
      succeeded: 2,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      level: "info",
      message: "batch_finished",
      request_id: "request",
      succeeded: 2,
    });
  });

  it("redacts argument, environment, output, and secret-like fields", () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => {
      lines.push(line);
    });

    logger.debug("sensitive", {
      argv: ["secret"],
      environment: { TOKEN: "secret" },
      stdout: "secret",
      access_token: "secret",
      command_id: "safe",
    });

    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      argv: "[REDACTED]",
      environment: "[REDACTED]",
      stdout: "[REDACTED]",
      access_token: "[REDACTED]",
      command_id: "safe",
    });
  });

  it("respects the configured level", () => {
    const lines: string[] = [];
    const logger = createLogger("warn", (line) => {
      lines.push(line);
    });

    logger.info("ignored");
    logger.warn("included");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"message":"included"');
  });
});
