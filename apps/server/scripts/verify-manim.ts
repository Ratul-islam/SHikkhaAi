/**
 * Proves the render path works end to end, the way `verify:r2` proves storage.
 *
 *   npm run verify:manim --workspace=apps/server
 *
 * Checks the whole chain in one run — interpreter, manim import, the AST gate
 * (both directions: a good scene passes AND a hostile one is rejected), a real
 * render with Bangla text and LaTeX, and the sandbox's own posture. Printed
 * with timings, because render time is the meter that binds now (PLAN.md §9.3)
 * and "how long does a scene take on this box" is the number worth knowing
 * before students find out.
 */

import { env } from "../src/config/env";
import {
  checkRenderHealth,
  renderScene,
  validateSceneSource,
} from "../src/modules/video/manim/render.service";

/** A scene of the shape the pipeline actually produces: Bangla via Pango, maths via LaTeX, motion driven by SCENE_DURATION. */
const SMOKE_SCENE = `from manim import *

class LessonScene(Scene):
    def construct(self):
        title = Text("মুক্তভাবে পড়ন্ত বস্তু", font="Noto Sans Bengali", font_size=40).to_edge(UP)
        equation = MathTex(r"v = g\\,t", font_size=48).to_corner(UR)
        ground = Line(LEFT * 6, RIGHT * 6, color=GREY).shift(DOWN * 3)
        ball = Circle(radius=0.35, color=RED, fill_opacity=1).move_to(UP * 2.2)

        self.play(Write(title), run_time=SCENE_DURATION * 0.2)
        self.play(Create(ground), FadeIn(ball), Write(equation), run_time=SCENE_DURATION * 0.2)
        self.play(ball.animate.move_to(DOWN * 2.6), rate_func=rate_functions.ease_in_quad,
                  run_time=SCENE_DURATION * 0.4)
        self.wait(SCENE_DURATION * 0.2)
`;

/** Must be rejected. If this ever renders, the AST gate is not doing its job. */
const HOSTILE_SCENE = `import os
from manim import *

class LessonScene(Scene):
    def construct(self):
        os.system("id")
        leaked = ().__class__.__bases__[0].__subclasses__()
`;

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(22)} ${value}\n`);
}

async function main(): Promise<void> {
  process.stdout.write("\nShikkhaAI — Manim render verification\n\n");

  process.stdout.write("Configuration\n");
  line("MANIM_ENABLED", env.MANIM_ENABLED);
  line("MANIM_PYTHON", env.MANIM_PYTHON);
  line("MANIM_QUALITY", `${env.MANIM_QUALITY} (${{ l: "480p15", m: "720p30", h: "1080p60" }[env.MANIM_QUALITY]})`);
  line("max concurrent", String(env.MANIM_MAX_CONCURRENT));
  line("scene timeout", `${env.MANIM_SCENE_TIMEOUT_MS} ms`);
  line("memory ceiling", `${env.MANIM_MEMORY_MB} MB`);

  process.stdout.write("\nHealth\n");
  const health = await checkRenderHealth(true);
  line("manim", health.manimVersion ?? "NOT IMPORTABLE");
  line("network isolation", health.networkIsolation ? "unshare -rn available" : "UNAVAILABLE (import allowlist only)");
  line("healthy", health.healthy ? "yes" : "no");
  for (const problem of health.problems) process.stdout.write(`    ! ${problem}\n`);

  if (!health.healthy) {
    process.stdout.write("\n✗ Renderer is not healthy — run `npm run setup:manim --workspace=apps/server` first.\n");
    process.exit(1);
  }

  process.stdout.write("\nAST gate\n");
  const hostile = await validateSceneSource(HOSTILE_SCENE);
  if (hostile.ok) {
    process.stdout.write("\n✗ FATAL: the hostile scene PASSED validation. Do not enable rendering.\n");
    process.exit(1);
  }
  line("hostile scene", `rejected (${hostile.errors.length} findings)`);
  for (const err of hostile.errors.slice(0, 3)) process.stdout.write(`    · ${err}\n`);

  const benign = await validateSceneSource(SMOKE_SCENE);
  line("smoke scene", benign.ok ? "accepted" : `REJECTED — ${benign.errors.join("; ")}`);
  if (!benign.ok) process.exit(1);

  process.stdout.write("\nRender\n");
  const targetMs = 8_000;
  const started = Date.now();
  const result = await renderScene({ source: SMOKE_SCENE, durationMs: targetMs });

  if (!result.ok) {
    process.stdout.write(`\n✗ render failed at stage "${result.stage}":\n${result.error}\n`);
    process.exit(1);
  }

  const wallMs = Date.now() - started;
  line("target duration", `${targetMs} ms`);
  line("actual duration", `${result.actualDurationMs} ms`);
  line("render time", `${result.renderMs} ms (${(targetMs / result.renderMs).toFixed(1)}x realtime)`);
  line("output size", `${(result.buffer.length / 1024).toFixed(0)} KB`);
  line("total wall", `${wallMs} ms`);

  process.stdout.write("\n✓ Render path verified — Bangla text, LaTeX, motion, sandbox, all working.\n");
  process.stdout.write("  Cost of that render: $0.00\n\n");
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
