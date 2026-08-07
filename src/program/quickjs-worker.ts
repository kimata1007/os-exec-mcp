import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSHandle,
} from "quickjs-emscripten";

import type { CommandResult } from "../executor/types.js";
import type { HostToWorkerMessage, WorkerInput, WorkerToHostMessage } from "./types.js";

if (parentPort === null) {
  throw new Error("quickjs-worker must run in a worker thread");
}
const port: MessagePort = parentPort;
const input = workerData as WorkerInput;
const deadline = Date.now() + input.timeoutMs;
let sentTerminalMessage = false;

function send(message: WorkerToHostMessage): void {
  port.postMessage(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 4096)
    : String(error).slice(0, 4096);
}

function valueHandle(context: QuickJSContext, value: CommandResult): QuickJSHandle {
  const serialized = JSON.stringify(value);
  const evaluated = context.evalCode(`JSON.parse(${JSON.stringify(serialized)})`);
  return context.unwrapResult(evaluated);
}

async function main(): Promise<void> {
  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(input.memoryBytes);
  runtime.setMaxStackSize(Math.min(1024 * 1024, Math.floor(input.memoryBytes / 8)));
  runtime.setInterruptHandler(() => Date.now() >= deadline);
  const context = runtime.newContext();
  const pending = new Map<number, ReturnType<QuickJSContext["newPromise"]>>();
  let nextRequestId = 1;
  let finished = false;
  let finalValue: unknown;

  const pumpJobs = (): void => {
    const result = runtime.executePendingJobs();
    if ("error" in result && result.error !== undefined) {
      const quickJsError = result.error;
      const dumped: unknown = quickJsError.context.dump(quickJsError);
      quickJsError.dispose();
      throw new Error(errorMessage(dumped));
    }
  };

  const handleResponse = (message: HostToWorkerMessage): void => {
    const deferred = pending.get(message.id);
    if (deferred === undefined) {
      return;
    }
    pending.delete(message.id);
    if (message.type === "exec_response") {
      const handle = valueHandle(context, message.result);
      deferred.resolve(handle);
      handle.dispose();
    } else {
      const handle = context.newError(message.message);
      deferred.reject(handle);
      handle.dispose();
    }
    pumpJobs();
  };
  port.on("message", handleResponse);

  const hostExec = context.newFunction("__hostExec", (argvHandle, optionsHandle) => {
    if (finished) {
      throw new Error("exec cannot be called after finish");
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const deferred = context.newPromise();
    pending.set(id, deferred);
    send({
      type: "exec_request",
      id,
      argv: context.dump(argvHandle),
      options:
        context.typeof(optionsHandle) === "undefined"
          ? {}
          : context.dump(optionsHandle),
    });
    return deferred.handle;
  });
  const hostFinish = context.newFunction("__hostFinish", (value) => {
    if (finished) {
      throw new Error("finish may only be called once");
    }
    if (pending.size > 0) {
      throw new Error(
        "finish cannot be called while exec operations are still pending",
      );
    }
    finalValue = context.dump(value);
    finished = true;
    return context.undefined;
  });
  context.setProp(context.global, "__hostExec", hostExec);
  context.setProp(context.global, "__hostFinish", hostFinish);
  hostExec.dispose();
  hostFinish.dispose();

  const helpers = context.evalCode(`
    "use strict";
    globalThis.exec = (argv, options = {}) => __hostExec(argv, options);
    globalThis.lines = (value) => {
      const text = typeof value === "string" ? value : value?.stdout;
      if (typeof text !== "string") throw new TypeError("lines expects a string or exec result");
      return text.split(/\\r?\\n/).filter((line, index, all) => line.length > 0 || index < all.length - 1);
    };
    globalThis.parallel = async (operations, concurrency = operations.length) => {
      if (!Array.isArray(operations)) throw new TypeError("parallel expects an array");
      if (!Number.isInteger(concurrency) || concurrency < 1) throw new TypeError("parallel concurrency must be a positive integer");
      const results = new Array(operations.length);
      let next = 0;
      const worker = async () => {
        while (next < operations.length) {
          const index = next++;
          const operation = operations[index];
          results[index] = typeof operation === "function" ? await operation() : await exec(operation);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, operations.length) }, worker));
      return results;
    };
    globalThis.finish = (value) => __hostFinish(value);
  `);
  context.unwrapResult(helpers).dispose();

  const evaluated = context.evalCode(
    `(async () => { "use strict";\n${input.source}\n})()`,
  );
  const promiseHandle = context.unwrapResult(evaluated);
  const settledPromise = context.resolvePromise(promiseHandle);
  promiseHandle.dispose();
  pumpJobs();
  const settledResult = await settledPromise;
  const settledHandle = context.unwrapResult(settledResult);
  settledHandle.dispose();

  const didFinish = (): boolean => finished;
  if (!didFinish()) {
    throw new Error("Program completed without calling finish(value)");
  }
  sentTerminalMessage = true;
  send({ type: "result", value: finalValue });
  port.close();
  context.dispose();
  runtime.dispose();
}

void main().catch((error: unknown) => {
  if (!sentTerminalMessage) {
    const message = errorMessage(error);
    send({
      type: "error",
      code: /out of memory|allocation failed|string too long|array too long/i.test(
        message,
      )
        ? "memory_limit"
        : Date.now() >= deadline
          ? "timeout"
          : "execution_failed",
      message,
    });
  }
  port.close();
});
