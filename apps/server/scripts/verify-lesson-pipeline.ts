/**
 * Proves the deterministic half of the lesson pipeline end to end:
 * render → conform → mux → concat.
 *
 *   npm run verify:pipeline --workspace=apps/server
 *
 * Spends nothing and calls no model: the "scenes" are hand-written Manim and
 * the "narration" is generated silence of known length. That is exactly what
 * makes it a useful check — it isolates the machinery from the model, so a
 * failure here is a real bug rather than a bad generation.
 *
 * The assertion that matters is the one this whole rebuild exists for
 * (PLAN.md §1, §7): each scene ends up EXACTLY as long as its narration, even
 * when the animation it was given is far too short or far too long. The scenes
 * below are deliberately mis-sized for that reason.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { renderScene, checkRenderHealth } from "../src/modules/video/manim/render.service";
import {
  concatListLine,
  concatScenes,
  conformVideoDuration,
  muxSceneAudio,
  probeDurationMs,
  runFfmpeg,
} from "../src/modules/video/ffmpeg.service";

/** A scene that runs far SHORT of its target — must be padded. */
const SHORT_SCENE = `from manim import *

class LessonScene(Scene):
    def construct(self):
        title = Text("ছোট দৃশ্য", font="Noto Sans Bengali", font_size=40)
        self.play(Write(title), run_time=1.0)
        self.wait(0.5)
`;

/** A scene that OVERRUNS its target — must be retimed or trimmed. */
const LONG_SCENE = `from manim import *

class LessonScene(Scene):
    def construct(self):
        dot = Dot(color=YELLOW).shift(LEFT * 5)
        eq = MathTex(r"v = u + at", font_size=44).to_edge(UP)
        label = Text("ত্বরণ", font="Noto Sans Bengali", font_size=30).next_to(eq, DOWN)
        self.play(Write(eq), FadeIn(label), run_time=3.0)
        self.play(dot.animate.shift(RIGHT * 10), rate_func=rate_functions.ease_in_quad, run_time=9.0)
        self.wait(2.0)
`;

/** A scene whose own arithmetic already fits — the control. */
const EXACT_SCENE = `from manim import *

class LessonScene(Scene):
    def construct(self):
        box = Square(side_length=2, color=BLUE, fill_opacity=0.4)
        cap = Text("সঠিক দৈর্ঘ্য", font="Noto Sans Bengali", font_size=32).next_to(box, DOWN)
        self.play(Create(box), FadeIn(cap), run_time=SCENE_DURATION * 0.4)
        self.play(box.animate.rotate(PI / 2), run_time=SCENE_DURATION * 0.4)
        self.wait(SCENE_DURATION * 0.2)
`;

/** Silence of an exact length, standing in for a narrated chunk. */
async function makeSilence(outPath: string, durationMs: number): Promise<void> {
  const outcome = await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=channel_layout=mono:sample_rate=24000",
    "-t",
    (durationMs / 1000).toFixed(3),
    "-c:a",
    "pcm_s16le",
    outPath,
  ]);
  if (outcome.code !== 0) throw new Error(`silence generation failed: ${outcome.stderr}`);
}

function line(label: string, value: string): void {
  process.stdout.write(`  ${label.padEnd(26)} ${value}\n`);
}

async function main(): Promise<void> {
  process.stdout.write("\nShikkhaAI — lesson pipeline verification (no model calls, $0.00)\n\n");

  const health = await checkRenderHealth(true);
  if (!health.healthy) {
    process.stdout.write(`✗ renderer unhealthy: ${health.problems.join("; ")}\n`);
    process.exit(1);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-verify-"));
  let failures = 0;

  try {
    // Narration lengths chosen to be nothing like the animations' natural ones.
    const scenes = [
      { id: "short", source: SHORT_SCENE, narrationMs: 9000 },
      { id: "long", source: LONG_SCENE, narrationMs: 5000 },
      { id: "exact", source: EXACT_SCENE, narrationMs: 7000 },
    ];

    const muxedPaths: string[] = [];
    let expectedTotalMs = 0;

    for (const scene of scenes) {
      process.stdout.write(`Scene "${scene.id}" — narration is ${scene.narrationMs} ms\n`);

      const rendered = await renderScene({ source: scene.source, durationMs: scene.narrationMs });
      if (!rendered.ok) {
        process.stdout.write(`  ✗ render failed (${rendered.stage}): ${rendered.error.slice(0, 200)}\n`);
        failures += 1;
        continue;
      }
      line("raw render", `${rendered.actualDurationMs} ms  (${rendered.renderMs} ms to render)`);

      const rawPath = path.join(workDir, `${scene.id}-raw.mp4`);
      const conformedPath = path.join(workDir, `${scene.id}-conformed.mp4`);
      await fs.writeFile(rawPath, rendered.buffer);

      const conform = await conformVideoDuration(rawPath, conformedPath, scene.narrationMs);
      if (!conform.ok) {
        process.stdout.write(`  ✗ conform failed: ${conform.error}\n`);
        failures += 1;
        continue;
      }

      const conformedMs = await probeDurationMs(conformedPath);
      const drift = Math.abs((conformedMs ?? 0) - scene.narrationMs);
      line("conform action", conform.action);
      line("after conform", `${conformedMs} ms`);
      line("drift from narration", `${drift} ms ${drift <= 100 ? "✓" : "✗ TOO LARGE"}`);
      if (drift > 100) failures += 1;

      const audioPath = path.join(workDir, `${scene.id}.wav`);
      await makeSilence(audioPath, scene.narrationMs);

      const muxedPath = path.join(workDir, `${scene.id}-muxed.mp4`);
      const mux = await muxSceneAudio(conformedPath, audioPath, muxedPath);
      if (!mux.ok) {
        process.stdout.write(`  ✗ mux failed: ${mux.error}\n`);
        failures += 1;
        continue;
      }
      muxedPaths.push(muxedPath);
      expectedTotalMs += scene.narrationMs;
      process.stdout.write("\n");
    }

    if (muxedPaths.length === scenes.length) {
      process.stdout.write("Lesson assembly\n");
      const listPath = path.join(workDir, "scenes.txt");
      await fs.writeFile(listPath, muxedPaths.map(concatListLine).join("\n"), "utf8");

      const outPath = path.join(workDir, "lesson.mp4");
      const concat = await concatScenes(listPath, outPath);
      if (!concat.ok) {
        process.stdout.write(`  ✗ concat failed: ${concat.error}\n`);
        failures += 1;
      } else {
        const totalMs = await probeDurationMs(outPath);
        const stat = await fs.stat(outPath);
        const totalDrift = Math.abs((totalMs ?? 0) - expectedTotalMs);
        line("expected total", `${expectedTotalMs} ms`);
        line("actual total", `${totalMs} ms`);
        line("total drift", `${totalDrift} ms ${totalDrift <= 200 ? "✓" : "✗ TOO LARGE"}`);
        line("lesson size", `${(stat.size / 1024).toFixed(0)} KB`);
        if (totalDrift > 200) failures += 1;
      }
    }

    process.stdout.write(
      failures === 0
        ? "\n✓ Every scene is exactly as long as its narration, and the lesson is the sum of them.\n  Total cost: $0.00\n\n"
        : `\n✗ ${failures} check(s) failed.\n\n`,
    );
    process.exit(failures === 0 ? 0 : 1);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${(err as Error).stack ?? String(err)}\n`);
  process.exit(1);
});
