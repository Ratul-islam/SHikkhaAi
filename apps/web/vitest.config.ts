import { defineConfig } from "vitest/config";

// Node environment only — the units tested here (lib/*.ts) are pure string and
// data helpers, not components, so no jsdom/browser setup is needed.
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
