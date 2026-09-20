import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Each PostgreSQL suite owns a container and two pools. Bound suite-level resource pressure;
    // the tests themselves still exercise concurrent clients, transactions, and processes.
    maxWorkers: 2,
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    retry: 0,
    allowOnly: false,
  },
});
