import { describe, expect, it } from "vitest";

import { ExecutionLimiter } from "../../src/executor/execution-limiter.js";

describe("ExecutionLimiter", () => {
  it("grants queued permits in FIFO order and tracks the global peak", async () => {
    const limiter = new ExecutionLimiter(1);
    const first = await limiter.acquire();
    const order: string[] = [];
    const second = limiter.acquire().then((permit) => {
      order.push("second");
      permit.release();
    });
    const third = limiter.acquire().then((permit) => {
      order.push("third");
      permit.release();
    });

    expect(limiter.queued).toBe(2);
    first.release();
    await Promise.all([second, third]);
    expect(order).toEqual(["second", "third"]);
    expect(limiter.peak).toBe(1);
  });

  it("removes an aborted waiter without consuming a permit", async () => {
    const limiter = new ExecutionLimiter(1);
    const first = await limiter.acquire();
    const controller = new AbortController();
    const waiting = limiter.acquire(controller.signal);
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    expect(limiter.queued).toBe(0);
    first.release();
    expect(limiter.active).toBe(0);
  });
});
