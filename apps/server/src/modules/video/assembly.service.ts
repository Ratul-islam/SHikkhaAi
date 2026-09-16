import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { putMedia } from "../../lib/mediaStore";
import { withRenderSlot } from "./manim/render.service";
import {
  concatListLine,
  concatScenes,
  conformVideoDuration,
  muxSceneAudio,
  probeDurationMs,
  transcodeNarration,
} from "./ffmpeg.service";
import { uploadsPathFromUrl, type SceneNarration, type SceneTiming } from "./scene-narration.service";

/**
 * Stage [3b]/[4] — conform each rendered scene to its narration, then join the
 * lesson (PLAN.md §7, §3).
 *
 * The conform step is where the sync guarantee is actually enforced. Everything
 * upstream ASKS for the right duration: the director sizes narration per scene,
 * the code-gen prompt is handed `SCENE_DURATION` and told to spend it. None of
 * that is trustworthy on its own — a model writes `run_time=2` where it meant
 * a fraction, and the scene comes out four seconds short.
 *
 * So the rendered clip is never believed. It is measured and then reshaped to
 * the audio. That is what makes "a scene is exactly as long as the words spoken
 * over it" a property of the system rather than a hope about the model.
 */

export interface RenderedSceneFile {
  sceneId: string;
  /** Raw Manim output — whatever length it happened to be. */
  buffer: Buffer;
}

export interface AssembledScene {
  sceneId: string;
  /** Stored URL of the scene's silent, duration-conformed clip. */
  videoUrl: string;
  durationMs: number;
}

/**
 * Conforms one rendered scene to its narration and stores it.
 *
 * Stored through `mediaStore`, never under `uploads/` — `uploadsRetention.ts`
 * sweeps that directory after 24 hours, which is right for throwaway narration
 * and wrong for a library asset the whole student body will reuse.
 */
export async function conformAndStoreScene(
  app: FastifyInstance,
  params: { sceneId: string; buffer: Buffer; targetMs: number },
): Promise<AssembledScene | null> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-conform-"));

  try {
    const rawPath = path.join(workDir, "raw.mp4");
    const conformedPath = path.join(workDir, "conformed.mp4");
    await fs.writeFile(rawPath, params.buffer);

    const result = await withRenderSlot(() => conformVideoDuration(rawPath, conformedPath, params.targetMs));
    if (!result.ok) {
      app.log.error({ sceneId: params.sceneId, error: result.error }, "Scene duration conform failed");
      return null;
    }

    if (result.action !== "none") {
      // Worth logging at info: a persistent "trim" means the code-gen prompt's
      // SCENE_DURATION instruction is not landing, which is a prompt bug to
      // fix rather than something to keep papering over in ffmpeg.
      app.log.info({ sceneId: params.sceneId, action: result.action }, "Conformed scene to its narration");
    }

    const conformed = await fs.readFile(conformedPath);
    const stored = await putMedia(`scene-${randomUUID()}.mp4`, conformed);

    return { sceneId: params.sceneId, videoUrl: stored.url, durationMs: params.targetMs };
  } catch (err) {
    app.log.error({ err, sceneId: params.sceneId }, "Scene assembly failed");
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Copies one scene's narration out of `uploads/` into durable storage and
 * returns its new URL, or null on failure.
 *
 * Narration is synthesized into `uploads/`, which is swept after 24h. That was
 * fine while a lesson was only ever played once; a SAVED lesson that pointed
 * there would replay silently the next day — the same failure CLAUDE.md records
 * for the `/uploads` proxy, arriving a day late instead of immediately.
 */
export async function storeNarration(app: FastifyInstance, narration: SceneNarration): Promise<string | null> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-narration-"));

  try {
    const outPath = path.join(workDir, "narration.m4a");
    const transcoded = await withRenderSlot(() => transcodeNarration(uploadsPathFromUrl(narration.audioUrl), outPath));
    if (!transcoded.ok) {
      app.log.error({ sceneId: narration.sceneId, error: transcoded.error }, "Narration transcode failed");
      return null;
    }
    const stored = await putMedia(`narration-${randomUUID()}.m4a`, await fs.readFile(outPath));
    return stored.url;
  } catch (err) {
    app.log.error({ err, sceneId: narration.sceneId }, "Storing narration failed");
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface LessonFileParams {
  scenes: { sceneId: string; videoBuffer: Buffer }[];
  narrations: SceneNarration[];
  timings: SceneTiming[];
}

/**
 * Builds the single downloadable MP4: each scene muxed with its own narration,
 * then all of them concatenated.
 *
 * This is what finally makes `deliveryMode: "FILE"` real — there was never a
 * server-side render before, only a browser-side Remotion player, so a
 * "downloadable video" was a promise nothing kept.
 *
 * Returns null rather than throwing: the interactive player works from the
 * per-scene URLs alone, so a failed concat costs the download, not the lesson.
 */
export async function assembleLessonFile(
  app: FastifyInstance,
  params: LessonFileParams,
): Promise<{ url: string; durationMs: number } | null> {
  if (params.scenes.length === 0) return null;

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-lesson-"));

  try {
    const muxedPaths: string[] = [];

    for (const [index, scene] of params.scenes.entries()) {
      const narration = params.narrations.find((n) => n.sceneId === scene.sceneId);
      if (!narration) {
        app.log.error({ sceneId: scene.sceneId }, "No narration for scene — cannot assemble lesson file");
        return null;
      }

      const videoPath = path.join(workDir, `scene-${index}.mp4`);
      const muxedPath = path.join(workDir, `muxed-${index}.mp4`);
      await fs.writeFile(videoPath, scene.videoBuffer);

      const muxed = await withRenderSlot(() => muxSceneAudio(videoPath, uploadsPathFromUrl(narration.audioUrl), muxedPath));
      if (!muxed.ok) {
        app.log.error({ sceneId: scene.sceneId, error: muxed.error }, "Scene mux failed");
        return null;
      }
      muxedPaths.push(muxedPath);
    }

    const listPath = path.join(workDir, "scenes.txt");
    await fs.writeFile(listPath, muxedPaths.map(concatListLine).join("\n"), "utf8");

    const outPath = path.join(workDir, "lesson.mp4");
    const concat = await withRenderSlot(() => concatScenes(listPath, outPath));
    if (!concat.ok) {
      app.log.error({ error: concat.error }, "Lesson concat failed");
      return null;
    }

    const durationMs = (await probeDurationMs(outPath)) ?? params.timings.reduce((t, s) => t + s.durationMs, 0);
    const buffer = await fs.readFile(outPath);
    const stored = await putMedia(`lesson-${randomUUID()}.mp4`, buffer);

    return { url: stored.url, durationMs };
  } catch (err) {
    app.log.error({ err }, "Lesson file assembly failed");
    return null;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
