import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000, // a hung async test fails loudly instead of stalling
    pool: "forks",
  },
});
