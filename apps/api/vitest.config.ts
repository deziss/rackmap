import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    globalSetup: ["./src/tests/global-setup.ts"],
    setupFiles: ["./src/tests/setup.ts"],
    // Spec files run one at a time because they share a real Postgres test
    // database, which global-setup.ts resets once per run. Each file still gets
    // its own fork (isolation on), so vi.mock() registrations never leak
    // between files; helpers.ts signs in once per role per file.
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
