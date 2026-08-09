import { describe, expect, it, vi } from "vitest";

import { OutputArtifactStore } from "../../src/executor/output-artifact-store.js";

describe("OutputArtifactStore", () => {
  it("uses opaque URIs, refuses overflow, and expires lazily", () => {
    vi.useFakeTimers();
    try {
      const store = new OutputArtifactStore(1000, 8);
      const firstUri = store.put("1234", 10, true);
      const secondUri = store.put("56789", 20, true);

      expect(firstUri).toMatch(/^os-exec-output:\/\/\/[0-9a-f-]+$/);
      expect(secondUri).toBeUndefined();
      expect(store.get(firstUri ?? "")).toMatchObject({
        text: "1234",
        totalBytes: 10,
        retainedBytes: 4,
        truncated: true,
      });

      vi.advanceTimersByTime(1001);
      expect(store.get(firstUri ?? "")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
