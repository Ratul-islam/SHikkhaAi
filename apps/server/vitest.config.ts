import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // The sandbox suite proves that a non-terminating scene gets killed, and
      // it proves it by waiting out this exact timeout. At the 120s production
      // default that single assertion costs two minutes of every test run; at
      // 15s it proves the same property. Production is unaffected — this only
      // applies under vitest.
      MANIM_SCENE_TIMEOUT_MS: "15000",
    },
  },
});
