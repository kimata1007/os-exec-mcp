import { performance } from "node:perf_hooks";

export type ExecutionPermit = {
  queueWaitMs: number;
  release: () => void;
};

type Waiter = {
  enqueuedAt: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  resolve: (permit: ExecutionPermit) => void;
  reject: (error: Error) => void;
};

export class ExecutionLimiterError extends Error {
  public override readonly name = "ExecutionLimiterError";

  public constructor(
    public readonly code: "cancelled" | "shutdown",
    message: string,
  ) {
    super(message);
  }
}

export class ExecutionLimiter {
  readonly #queue: Waiter[] = [];
  #active = 0;
  #peak = 0;
  #shutdown = false;

  public constructor(public readonly maximumConcurrency: number) {
    if (!Number.isInteger(maximumConcurrency) || maximumConcurrency < 1) {
      throw new Error("maximumConcurrency must be a positive integer");
    }
  }

  public get active(): number {
    return this.#active;
  }

  public get queued(): number {
    return this.#queue.length;
  }

  public get peak(): number {
    return this.#peak;
  }

  public acquire(signal?: AbortSignal): Promise<ExecutionPermit> {
    if (this.#shutdown) {
      return Promise.reject(
        new ExecutionLimiterError("shutdown", "Execution limiter is shutting down"),
      );
    }
    if (signal?.aborted === true) {
      return Promise.reject(
        new ExecutionLimiterError(
          "cancelled",
          "Command cancelled while waiting to start",
        ),
      );
    }
    if (this.#active < this.maximumConcurrency && this.#queue.length === 0) {
      return Promise.resolve(this.#grant(performance.now()));
    }

    return new Promise<ExecutionPermit>((resolve, reject) => {
      const waiter: Waiter = {
        enqueuedAt: performance.now(),
        resolve,
        reject,
        ...(signal === undefined ? {} : { signal }),
      };
      if (signal !== undefined) {
        waiter.abortListener = (): void => {
          const index = this.#queue.indexOf(waiter);
          if (index !== -1) {
            this.#queue.splice(index, 1);
            reject(
              new ExecutionLimiterError(
                "cancelled",
                "Command cancelled while waiting for a global execution slot",
              ),
            );
          }
        };
        signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
      this.#queue.push(waiter);
    });
  }

  public shutdown(): void {
    if (this.#shutdown) {
      return;
    }
    this.#shutdown = true;
    for (const waiter of this.#queue.splice(0)) {
      this.#cleanupWaiter(waiter);
      waiter.reject(
        new ExecutionLimiterError("shutdown", "Execution limiter is shutting down"),
      );
    }
  }

  #grant(enqueuedAt: number): ExecutionPermit {
    this.#active += 1;
    this.#peak = Math.max(this.#peak, this.#active);
    let released = false;
    return {
      queueWaitMs: Math.max(0, Math.round(performance.now() - enqueuedAt)),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#active -= 1;
        this.#drain();
      },
    };
  }

  #drain(): void {
    while (
      !this.#shutdown &&
      this.#active < this.maximumConcurrency &&
      this.#queue.length > 0
    ) {
      const waiter = this.#queue.shift();
      if (waiter === undefined) {
        return;
      }
      this.#cleanupWaiter(waiter);
      if (waiter.signal?.aborted === true) {
        waiter.reject(
          new ExecutionLimiterError(
            "cancelled",
            "Command cancelled while waiting for a global execution slot",
          ),
        );
        continue;
      }
      waiter.resolve(this.#grant(waiter.enqueuedAt));
    }
  }

  #cleanupWaiter(waiter: Waiter): void {
    if (waiter.signal !== undefined && waiter.abortListener !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }
}
