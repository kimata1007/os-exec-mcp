import { Buffer } from "node:buffer";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const SENSITIVE_ATTRIBUTE_KEYS = new Set(["prompt", "user.account_id", "user.email"]);

function parseArguments(arguments_) {
  const parsed = {
    host: "127.0.0.1",
    port: 4318,
    output: path.resolve("benchmark", "results", "otel-capture.jsonl"),
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument !== "--host" && argument !== "--port" && argument !== "--output") {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = arguments_[index + 1];
    if (value === undefined) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--port") {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--port must be an integer between 1 and 65535");
      }
      parsed.port = port;
    } else {
      parsed[argument.slice(2)] = value;
    }
    index += 1;
  }
  parsed.output = path.resolve(parsed.output);
  return parsed;
}

function redactSensitiveAttributes(value) {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveAttributes(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (typeof value.key === "string" && SENSITIVE_ATTRIBUTE_KEYS.has(value.key)) {
    return {
      ...value,
      value: { stringValue: "[REDACTED]" },
    };
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactSensitiveAttributes(item)]),
  );
}

export async function startOtelCapture(options) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  const outputPath = path.resolve(options.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, "", "utf8");

  let pendingWrite = Promise.resolve();
  let writeError;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body;
      try {
        body = redactSensitiveAttributes(JSON.parse(rawBody));
      } catch {
        body = {
          parse_error: true,
          omitted_body_bytes: Buffer.byteLength(rawBody),
        };
      }
      const record = {
        received_at: new Date().toISOString(),
        method: request.method,
        path: request.url,
        content_type: request.headers["content-type"] ?? null,
        body,
      };
      pendingWrite = pendingWrite
        .then(async () => {
          await appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
        })
        .catch((error) => {
          writeError = error;
        });
      void pendingWrite.then(() => {
        if (writeError === undefined) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end('{"error":"capture write failed"}');
      });
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("OTel capture server did not expose a TCP address");
  }
  const baseUrl = `http://${host}:${address.port}`;
  let closed = false;
  return {
    baseUrl,
    logsEndpoint: `${baseUrl}/v1/logs`,
    tracesEndpoint: `${baseUrl}/v1/traces`,
    metricsEndpoint: `${baseUrl}/v1/metrics`,
    outputPath,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
      await pendingWrite;
      if (writeError !== undefined) {
        throw writeError;
      }
    },
  };
}

async function main() {
  const configuration = parseArguments(process.argv.slice(2));
  const capture = await startOtelCapture({
    host: configuration.host,
    port: configuration.port,
    outputPath: configuration.output,
  });
  process.stdout.write(`otel_capture_ready=${capture.baseUrl}\n`);
  process.stdout.write(`output=${capture.outputPath}\n`);

  const shutdown = async () => {
    await capture.close();
  };
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  await main();
}
