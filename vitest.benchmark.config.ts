import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/capacity.benchmark.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
    allowOnly: false,
    hookTimeout: 120_000,
    testTimeout: 1_200_000,
  },
});
