import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      reporter: ["text", "html"],
    },
    fileParallelism: true,
    hookTimeout: 15_000,
    testTimeout: 15_000,
  },
});
