import path from "node:path";
import type { FastifyInstance } from "fastify";
import { env, isGeminiTtsConfigured } from "../../config/env";
import { synthesizeNarration, UPLOADS_DIR, type WordTiming } from "../speech/edge-speech.service";
import { synthesizeNarrationGemini } from "../speech/gemini-speech.service";
import { probeDurationMs } from "./ffmpeg.service";
import type { DirectedScene } from "./director.schema";
import { recordSpend } from "./library.service";

/**
 * Stage [2] — narrate each scene SEPARATELY (PLAN.md §3).
 *
 * This is the smallest change in the pipeline and the one that actually fixes
 * the bug. Previously one TTS call produced one audio track for the whole
 * lesson, and scene boundaries had to be *inferred* afterwards by matching a
 * cue's `highlightText` against the word timeline (cue-align.service.ts) —
 * an estimate layered on an estimate, and the thing that drifted.
 *
 * Narrating per scene inverts it: a scene's duration is a MEASURED PROPERTY of
 * its own audio. Scene N starts exactly where scene N-1's audio ended, by
 * construction. There is nothing left to reconcile, so there is nothing left
 * to drift.
 *
 * It is also cheaper. The old cache keyed on the entire script, so editing one
 * sentence re-billed the whole lesson; keyed per chunk, an edited scene
 * re-bills ~20 seconds of speech, and analogy scenes recur across lessons
 * (PLAN.md §9.1).
 */

export interface SceneNarration {
  sceneId: string;
  /** Fetchable path under /uploads. */
  audioUrl: string;
  /** Measured, not estimated — this IS the scene's length. */
  durationMs: number;
  /** Word timings relative to THIS scene's own start. */
  timestamps: WordTiming[];
  costUsd: number;
}

export interface NarrationBatch {
  /** Present only when every scene has audio; a partial batch is not usable. */
  narrations: SceneNarration[] | null;
  /** How many scenes are still synthesizing in the background. */
  pending: number;
  totalCostUsd: number;
}

/** `/uploads/tts-x.wav` → the file on disk, so it can be probed and muxed. */
export function uploadsPathFromUrl(audioUrl: string): string {
  return path.join(UPLOADS_DIR, path.basename(audioUrl));
}

/**
 * Exact duration for a narration file.
 *
 * ffprobe rather than "the last word's `endMs`". For Gemini those agree —
 * `alignWords` pins the final word to the true total — but Edge-TTS reports
 * word boundaries, and a script ending in a full stop leaves real trailing
 * silence after the last boundary. Using the word timeline there would make
 * every scene fractionally short, and those fractions would accumulate down a
 * six-scene lesson into exactly the drift this design exists to prevent.
 */
async function measureDurationMs(audioUrl: string, timestamps: WordTiming[]): Promise<number> {
  const probed = await probeDurationMs(uploadsPathFromUrl(audioUrl));
  if (probed !== null) return probed;
  // Probe failed (unreadable file, ffprobe missing). The word timeline is a
  // worse answer but a usable one, and losing the lesson over it would be a
  // poor trade.
  return timestamps.at(-1)?.endMs ?? 0;
}

/**
 * Narrates one scene, awaiting the result.
 *
 * Deliberately blocking, unlike the old `/video/build` narration path which had
 * to fire-and-forget and let the client poll. The difference is where this now
 * runs: the whole lesson build is a background job (lesson-build.service.ts),
 * so there is no HTTP connection being held open and therefore no proxy ceiling
 * to duck under. The no-blocking rule in CLAUDE.md is about the REQUEST, and
 * this is no longer on it.
 *
 * A Gemini failure falls through to Edge rather than failing the scene. That
 * rule predates this file and dropping it was a real regression: losing voice
 * quality is a far smaller harm than losing the video, and the Gemini endpoint
 * is erratic enough to make it matter — the same 122-character chunk measured
 * 6.5s, 18s, 35s and once over 90s on consecutive calls.
 *
 * Both engines cache by script+voice, so a re-run costs nothing.
 */
async function narrateScene(app: FastifyInstance, userId: string, scene: DirectedScene): Promise<SceneNarration> {
  if (isGeminiTtsConfigured()) {
    try {
      const result = await synthesizeNarrationGemini(scene.narration);
      if (result.costUsd > 0) {
        await recordSpend(app, { userId, kind: "TTS", model: env.TTS_MODEL, costUsd: result.costUsd }).catch((err) =>
          app.log.error(err, "Failed to record TTS spend"),
        );
      }
      return {
        sceneId: scene.id,
        audioUrl: result.audioUrl,
        durationMs: await measureDurationMs(result.audioUrl, result.timestamps),
        timestamps: result.timestamps,
        costUsd: result.costUsd,
      };
    } catch (err) {
      app.log.warn({ err, sceneId: scene.id }, "Gemini narration failed — falling back to Edge-TTS");
    }
  }

  // Edge-TTS: free, local, ~2s for a scene chunk, and it returns EXACT per-word
  // boundaries rather than the derived ones Gemini needs — so the cheaper engine
  // is also the more accurate one for beat alignment (PLAN.md §9.1).
  const result = await synthesizeNarration(scene.narration, "bn-BD");
  return {
    sceneId: scene.id,
    audioUrl: result.audioUrl,
    durationMs: await measureDurationMs(result.audioUrl, result.timestamps),
    timestamps: result.timestamps,
    costUsd: 0,
  };
}

/**
 * How many scenes may be narrated at once.
 *
 * Gemini is plain HTTP and wildly variable per call (6s to over 90s for the
 * same text), so serialising it multiplies the worst case by the scene count —
 * four scenes took long enough that the client gave up polling before the
 * lesson existed. In parallel the batch costs about as long as its slowest
 * member instead of their sum.
 *
 * Edge-TTS gets a lower cap: it opens a websocket per synthesis against a free
 * public service, and at ~2s a scene there is little to gain from pushing it.
 */
function narrationConcurrency(): number {
  return isGeminiTtsConfigured() ? 4 : 2;
}

/**
 * Narrates every scene, preserving order.
 *
 * Order matters and parallelism must not disturb it: `buildTimeline` lays the
 * results end to end, so a reordered array would silently reshuffle the lesson.
 * Each worker therefore writes into its own slot rather than pushing.
 */
export async function narrateScenes(
  app: FastifyInstance,
  userId: string,
  scenes: DirectedScene[],
): Promise<NarrationBatch> {
  const results: (SceneNarration | null)[] = new Array(scenes.length).fill(null);
  const limit = narrationConcurrency();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= scenes.length) return;
      const scene = scenes[index]!;
      try {
        results[index] = await narrateScene(app, userId, scene);
      } catch (err) {
        app.log.error({ err, sceneId: scene.id }, "Scene narration failed on both engines");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, scenes.length) }, worker));

  const narrations = results.filter((r): r is SceneNarration => r !== null);
  const pending = scenes.length - narrations.length;

  return {
    // All or nothing: a lesson missing one scene's audio has a hole in its
    // timeline, and every later scene's start would be wrong.
    narrations: pending === 0 ? narrations : null,
    pending,
    totalCostUsd: narrations.reduce((sum, n) => sum + n.costUsd, 0),
  };
}

/* ── Timeline assembly ──────────────────────────────────────────────────────*/

export interface SceneTiming {
  sceneId: string;
  startMs: number;
  durationMs: number;
}

/**
 * Lays the narrated scenes end to end.
 *
 * Three lines, and they are the entire sync guarantee: each scene begins where
 * the previous one's audio ended. No word matching, no estimate, nothing that
 * can be off by a footage length.
 */
export function buildTimeline(narrations: SceneNarration[]): { timings: SceneTiming[]; totalMs: number } {
  const timings: SceneTiming[] = [];
  let cursor = 0;

  for (const narration of narrations) {
    timings.push({ sceneId: narration.sceneId, startMs: cursor, durationMs: narration.durationMs });
    cursor += narration.durationMs;
  }

  return { timings, totalMs: cursor };
}

/**
 * The lesson-wide word manifest: each scene's own timings shifted by where
 * that scene starts.
 *
 * Karaoke captions and `timestamp-ask` both read a single lesson-relative
 * manifest, so this keeps them working untouched while the audio underneath is
 * now several files.
 */
export function concatTimestamps(narrations: SceneNarration[], timings: SceneTiming[]): WordTiming[] {
  const manifest: WordTiming[] = [];

  narrations.forEach((narration, index) => {
    const offset = timings[index]?.startMs ?? 0;
    for (const word of narration.timestamps) {
      manifest.push({ word: word.word, startMs: word.startMs + offset, endMs: word.endMs + offset });
    }
  });

  return manifest;
}

/**
 * Places a scene's beats on the lesson timeline.
 *
 * A beat's `at` is a fraction of its own scene (PLAN.md §4), so this is a
 * multiply and an add. The clamp is what guarantees the property that matters:
 * a beat can never escape its own scene, however the director numbered it —
 * which is why a fallback scene still lands in exactly the right slot.
 */
export function placeBeats(
  scene: DirectedScene,
  timing: SceneTiming,
): { timeMs: number; highlightText: string; focusX?: number; focusY?: number }[] {
  return scene.beats.map((beat) => {
    const raw = timing.startMs + beat.at * timing.durationMs;
    const clamped = Math.min(timing.startMs + timing.durationMs, Math.max(timing.startMs, raw));
    return {
      timeMs: Math.round(clamped),
      highlightText: beat.highlightText,
      ...(beat.focusX !== undefined ? { focusX: beat.focusX } : {}),
      ...(beat.focusY !== undefined ? { focusY: beat.focusY } : {}),
    };
  });
}
