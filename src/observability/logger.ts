import process from "node:process";

import type { LogLevel } from "../config/schema.js";

export type LogFields = Readonly<Record<string, unknown>>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
};

type Sink = (line: string) => void;

const LEVEL_VALUES: Readonly<Record<Exclude<LogLevel, "silent">, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SECRET_FIELD_PATTERN =
  /(?:authorization|cookie|credential|password|secret|token|stdout|stderr|argv|environment|env)/i;

function sanitizedFields(fields: LogFields): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      SECRET_FIELD_PATTERN.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

export function createLogger(
  configuredLevel: LogLevel,
  sink: Sink = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Logger {
  const minimumLevel =
    configuredLevel === "silent"
      ? Number.POSITIVE_INFINITY
      : LEVEL_VALUES[configuredLevel];

  const write = (
    level: Exclude<LogLevel, "silent">,
    message: string,
    fields: LogFields = {},
  ): void => {
    if (LEVEL_VALUES[level] < minimumLevel) {
      return;
    }
    sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        message,
        ...sanitizedFields(fields),
      }),
    );
  };

  return {
    debug: (message, fields) => {
      write("debug", message, fields);
    },
    info: (message, fields) => {
      write("info", message, fields);
    },
    warn: (message, fields) => {
      write("warn", message, fields);
    },
    error: (message, fields) => {
      write("error", message, fields);
    },
  };
}
