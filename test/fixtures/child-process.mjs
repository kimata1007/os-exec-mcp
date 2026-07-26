import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import process from "node:process";
import { setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const [mode, ...arguments_] = process.argv.slice(2);
const thisFile = fileURLToPath(import.meta.url);

async function writeWithBackpressure(stream, buffer) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off("error", onError);
      reject(error);
    };
    stream.once("error", onError);
    if (stream.write(buffer)) {
      stream.off("error", onError);
      resolve();
      return;
    }
    stream.once("drain", () => {
      stream.off("error", onError);
      resolve();
    });
  });
}

switch (mode) {
  case "delay": {
    const delayMs = Number(arguments_[0] ?? "100");
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    process.stdout.write(
      JSON.stringify({ startedAt, endedAt: Date.now(), pid: process.pid }),
    );
    break;
  }
  case "echo": {
    process.stdout.write(arguments_[0] ?? "stdout");
    process.stderr.write(arguments_[1] ?? "stderr");
    break;
  }
  case "exit": {
    process.exitCode = Number(arguments_[0] ?? "1");
    process.stderr.write(`exit=${process.exitCode}`);
    break;
  }
  case "large": {
    const bytesPerStream = Number(arguments_[0] ?? "262144");
    const chunkSize = 8192;
    let written = 0;
    while (written < bytesPerStream) {
      const size = Math.min(chunkSize, bytesPerStream - written);
      await Promise.all([
        writeWithBackpressure(process.stdout, Buffer.alloc(size, 0x6f)),
        writeWithBackpressure(process.stderr, Buffer.alloc(size, 0x65)),
      ]);
      written += size;
    }
    break;
  }
  case "invalid-utf8": {
    process.stdout.write(Buffer.from([0xff, 0xfe, 0x61]));
    break;
  }
  case "tree-parent": {
    const pidFile = arguments_[0];
    if (pidFile === undefined) {
      throw new Error("tree-parent requires a pid file");
    }
    const child = spawn(process.execPath, [thisFile, "tree-child", pidFile], {
      detached: false,
      stdio: "ignore",
    });
    if (child.pid === undefined) {
      throw new Error("tree child did not receive a PID");
    }
    await writeFile(pidFile, String(child.pid), "utf8");
    child.unref();
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    break;
  }
  case "tree-child": {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    break;
  }
  default:
    throw new Error(`Unknown fixture mode: ${mode ?? "(missing)"}`);
}
