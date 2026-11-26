import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["db/tests/**/*.test.ts", "src/**/*.test.ts"], fileParallelism: false },
});
