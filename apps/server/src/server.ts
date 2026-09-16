import { buildApp } from "./app";
import { env } from "./config/env";
import { checkRenderHealth, manimNamesFile } from "./modules/video/manim/render.service";

const app = buildApp();

// PLAN.manim-video.md §3.2: health is asserted once, at boot, and an unhealthy
// renderer says so LOUDLY rather than quietly serving every lesson through the
// caption-card fallback. Without this the probe first runs lazily, inside the
// first lesson build, so a deployment whose render environment was never built
// looks fine at startup and only shows up as videos with no animation.
//
// Fire-and-forget on purpose: the probe spawns a python `import manim` that
// costs a second or two, and it must never delay or fail `listen()`. It lives
// here rather than in `buildApp()` so the test suite doesn't spawn an
// interpreter every time it builds an app.
void checkRenderHealth()
  .then((health) => {
    if (health.healthy) {
      app.log.info(
        { manim: health.manimVersion, networkIsolation: health.networkIsolation },
        "Manim renderer ready",
      );
      // Pay the validator's one manim import now, after the probe's (never
      // alongside it — two at once is ~250MB on a 512MB host), rather than
      // inside the first student's lesson build.
      void manimNamesFile().then((file) =>
        file
          ? app.log.info("Scene validator ready")
          : app.log.warn("Scene validator name list unavailable — each validation will import manim"),
      );
    } else {
      app.log.error(
        { problems: health.problems, manimPython: env.MANIM_PYTHON, manimEnabled: env.MANIM_ENABLED },
        "Manim renderer UNHEALTHY — every lesson scene will fall back to a caption card",
      );
    }
  })
  .catch((err) => app.log.error({ err }, "Manim health probe failed to run"));

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
