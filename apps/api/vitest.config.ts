import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./src/tests/setup.ts"],
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
