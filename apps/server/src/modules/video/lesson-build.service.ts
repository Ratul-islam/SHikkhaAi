import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import type { WordTiming } from "../speech/edge-speech.service";
import { directLesson } from "./director.service";
import { generateSceneCode, type SceneCodeResult } from "./scene-code.service";
import { renderScene, renderCacheKey, isRendererReady, checkRenderHealth } from "./manim/render.service";
import { assembleLessonFile, conformAndStoreScene, storeNarration } from "./assembly.service";
import { getMedia } from "../../lib/mediaStore";
import {
  buildTimeline,
  concatTimestamps,
  narrateScenes,
  placeBeats,
  type SceneNarration,
  type SceneTiming,
} from "./scene-narration.service";
import {
  checkBudget,
  findReusableLesson,
  LESSON_KIND,
  PARTIAL_KIND,
  publishLesson,
  recordReuse,
  recordSpend,
  type LibraryLesson,
  type StoredLessonPayload,
} from "./library.service";
import type { DirectedScene, DirectedScript, VideoBrief } from "./director.schema";

/**
 * Drives stages [1]→[5] of PLAN.md §3 and owns the polling contract.
 *
 * `/video/build` must never block (CLAUDE.md: the Next dev rewrite cuts at
 * exactly 30s with a bare, non-JSON 500, and every production gateway has a
 * similar ceiling). A full build is director + narration + code-gen + render +
 * assembly — roughly 90s cold — so the route asks THIS for whatever is ready
 * now, and a build that isn't ready runs in the background while the client
 * polls.
 *
 * The in-flight map is what stops every poll starting another build. Without
 * it a student watching a 90s build would kick off a dozen duplicate lessons
 * and pay for every one of their narrations.
 */

export interface LessonSceneView {
  id: string;
  startMs: number;
  durationMs: number;
  /** This scene's own narration — the clock everything else conforms to. */
  audioUrl: string;
  /** The rendered Manim clip. Absent means this scene fell back (PLAN.md §8). */
  videoUrl?: string;
  narration: string;
  beats: { timeMs: number; highlightText: string; focusX?: number; focusY?: number }[];
}

export interface LessonPayload {
  title: string;
  conceptKey: string;
  scenes: LessonSceneView[];
  /** The assembled MP4 — the download, and what `deliveryMode: "FILE"` finally means. */
  lessonUrl?: string;
  totalDurationMs: number;
  /** Lesson-relative, so karaoke captions and timestamp-ask work unchanged. */
  timestampManifest: WordTiming[];
  reused: boolean;
  /** How many scenes actually rendered, against how many exist — the §3.2 health signal. */
  renderedSceneCount: number;
}

export interface BuildResult {
  lesson: LessonPayload | null;
  generating: boolean;
  /** Set when the build failed outright, so the client can stop polling and say why. */
  failed?: string;
}

interface BuildRequest {
  userId: string;
  classLevel: number;
  subject: string;
  chapter: number;
  nodeId?: string | null;
  brief: VideoBrief;
  weakTopics?: string[];
  wantsNewVariant?: boolean;
}

/* ── In-flight builds ───────────────────────────────────────────────────────*/

interface BuildSlot {
  promise: Promise<LessonPayload | null>;
  startedAt: number;
  result?: LessonPayload | null;
  error?: string;
}

const inFlight = new Map<string, BuildSlot>();

/**
 * Keyed by concept, not by user: two students asking the same thing at the same
 * moment should share one build and one bill, exactly as they share the library
 * entry afterwards.
 */
function buildKey(req: BuildRequest): string {
  return req.nodeId ?? `${req.classLevel}:${req.subject}:${req.chapter}:${req.brief.conceptKey}`;
}

/** How long a finished build stays in memory so the poll that follows it lands. */
const RESULT_TTL_MS = 5 * 60 * 1000;

/**
 * Hard ceiling on one build.
 *
 * Without this a single hung upstream call pins the slot forever: `result`
 * stays undefined, so every later poll for that concept answers
 * `generating: true` for the life of the process — the student sees a spinner
 * that never resolves, and retrying cannot help because the retry joins the
 * same dead slot. That is exactly how a slow TTS endpoint turned into "the
 * video never loads."
 *
 * Sized well above a realistic cold build (~90s) so it only ever catches a
 * genuine hang, never a slow success.
 */
const BUILD_DEADLINE_MS = 6 * 60 * 1000;

/** How long a FAILED build is remembered — see the note where it is used. */
const FAILED_TTL_MS = 30 * 1000;

/* ── Scene rendering ────────────────────────────────────────────────────────*/

interface BuiltScene {
  view: LessonSceneView;
  /** Present when the scene rendered; assembly needs the bytes to build the MP4. */
  videoBuffer?: Buffer;
}

/**
 * Renders one scene, through the cache.
 *
 * The cache is content-addressed on the generated source plus the target
 * duration, so identical Manim at an identical length is rendered once for the
 * whole student body — the cheapest layer in PLAN.md §9.2, since a hit costs
 * neither dollars nor CPU.
 */
async function buildScene(
  app: FastifyInstance,
  params: {
    userId: string;
    script: DirectedScript;
    scene: DirectedScene;
    index: number;
    narration: SceneNarration;
    timing: SceneTiming;
    /** Round 0's code, already being generated alongside narration. */
    firstDraft?: Promise<SceneCodeResult>;
  },
): Promise<BuiltScene> {
  const { script, scene, index, narration, timing, firstDraft } = params;

  const view: LessonSceneView = {
    id: scene.id,
    startMs: timing.startMs,
    durationMs: timing.durationMs,
    audioUrl: narration.audioUrl,
    narration: scene.narration,
    beats: placeBeats(scene, timing),
  };

  // Generate → render → and if the render CRASHES, feed the traceback back and
  // try once more. The earlier version retried only on a validator rejection,
  // which missed the commoner failure entirely: code that parses cleanly and
  // then dies at run time (`always_redraw` evaluating a lambda before its
  // helper exists; a mobject that loads a file). A traceback is a far better
  // repair prompt than a static error, so this is the rung that earns its cost.
  const failures: string[] = [];

  for (let round = 0; round <= env.MANIM_MAX_RETRIES; round++) {
    const generated =
      round === 0 && firstDraft
        ? await firstDraft
        : await generateSceneCode(app, {
            script,
            scene,
            index,
            durationMs: timing.durationMs,
            priorFailures: failures,
          });

    if (!generated.source) {
      app.log.warn({ sceneId: scene.id, attempts: generated.attempts.length }, "Scene code generation failed — scene falls back");
      return { view };
    }

    const cacheKey = renderCacheKey(generated.source, timing.durationMs);
    const cached = await app.prisma.renderedScene.findUnique({ where: { sourceHash: cacheKey } }).catch(() => null);
    if (cached) {
      await app.prisma.renderedScene
        .update({ where: { id: cached.id }, data: { timesReused: { increment: 1 } } })
        .catch(() => undefined);
      // Fetch the bytes back. Returning only the URL used to skip the MP4 —
      // and since a lesson was saved only with its MP4, every cache hit meant
      // the lesson was thrown away: the better the cache, the less was kept.
      // A failed fetch still plays (the player needs only the URL); it just
      // costs the single-file download.
      const videoBuffer = await getMedia(cached.url).catch((err) => {
        app.log.warn({ err, sceneId: scene.id }, "Cached scene fetch failed — lesson will have no MP4");
        return undefined;
      });
      return { view: { ...view, videoUrl: cached.url }, ...(videoBuffer ? { videoBuffer } : {}) };
    }

    const rendered = await renderScene({ source: generated.source, durationMs: timing.durationMs });

    if (!rendered.ok) {
      app.log.warn(
        // The TAIL of a traceback names the exception; the head is boilerplate.
        { sceneId: scene.id, stage: rendered.stage, round, error: rendered.error.slice(-400) },
        "Scene render failed",
      );
      // A timeout or an unhealthy renderer is not something regenerating can
      // fix — only a crash in the scene's own code is. Retrying the others
      // would just spend another call to fail the same way.
      if (rendered.stage !== "render" || round === env.MANIM_MAX_RETRIES) return { view };
      failures.push(`The scene rendered with this error:\n${rendered.error.slice(-1200)}`);
      continue;
    }

    await recordSpend(app, {
      userId: params.userId,
      kind: "RENDER",
      model: `manim-${env.MANIM_QUALITY}`,
      costUsd: 0,
      cpuMs: rendered.renderMs,
    }).catch((err) => app.log.error(err, "Failed to record render"));

    const stored = await conformAndStoreScene(app, {
      sceneId: scene.id,
      buffer: rendered.buffer,
      targetMs: timing.durationMs,
    });
    if (!stored) return { view };

    await app.prisma.renderedScene
      .create({
        data: { sourceHash: cacheKey, url: stored.videoUrl, durationMs: timing.durationMs, renderMs: rendered.renderMs },
      })
      .catch((err) => app.log.error(err, "Failed to cache rendered scene"));

    return { view: { ...view, videoUrl: stored.videoUrl }, videoBuffer: rendered.buffer };
  }

  return { view };
}

/* ── The build ──────────────────────────────────────────────────────────────*/

/**
 * A scene's narration length, guessed from its word count before the audio
 * exists. Only ever shown to the code generator as "about N seconds": the
 * scene code is written against the SCENE_DURATION variable, which gets the
 * MEASURED value at render time, and the clip is conformed to the audio
 * afterwards regardless — so a rough guess costs nothing in sync.
 */
function estimateNarrationMs(narration: string): number {
  const words = narration.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(60_000, Math.max(3_000, words * 450));
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping results in input order. */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function runBuild(app: FastifyInstance, req: BuildRequest): Promise<LessonPayload | null> {
  // One line per build with where the time went, so "video is slow" is a
  // number to look at rather than a guess.
  const startedAt = Date.now();
  const stageMs: Record<string, number> = {};
  let stageStart = startedAt;
  const endStage = (name: string): void => {
    const now = Date.now();
    stageMs[name] = now - stageStart;
    stageStart = now;
  };

  // [1] Direct.
  const directed = await directLesson(app, {
    userId: req.userId,
    classLevel: req.classLevel,
    subject: req.subject,
    chapter: req.chapter,
    brief: req.brief,
    weakTopics: req.weakTopics,
  });
  endStage("directMs");

  if (!directed.script) {
    app.log.warn({ reason: directed.reason }, "Lesson direction failed");
    return null;
  }
  const script = directed.script;

  await recordSpend(app, { userId: req.userId, kind: "DIRECTOR", model: env.CHAT_MODEL_NAME, costUsd: 0.001 }).catch(
    () => undefined,
  );

  // The renderer check comes first now, because it decides whether code
  // generation starts at all.
  const rendererReady = await isRendererReady();
  if (!rendererReady) {
    // The reasons, not just the symptom: this fires once per lesson on a
    // deployment whose render environment was never built, and without the
    // probe's own findings the log can't distinguish "no interpreter at
    // MANIM_PYTHON" from a venv that exists but can't import manim.
    const health = await checkRenderHealth();
    app.log.warn(
      { problems: health.problems, manimPython: env.MANIM_PYTHON, manimEnabled: env.MANIM_ENABLED },
      "Manim renderer unavailable — every scene will fall back to the drawn path",
    );
  }

  // [2] + [3a] Narrate each scene AND write its first draft of code, at the
  // same time. Code generation used to wait for narration only so its prompt
  // could print the measured duration — but the code uses the SCENE_DURATION
  // variable, not the number, so that wait serialised the two slowest model
  // stages for nothing. If narration then fails, these drafts are wasted:
  // a few cents of chat against a build that was failing anyway.
  const firstDrafts: Promise<SceneCodeResult>[] = rendererReady
    ? script.scenes.map((scene, index) =>
        generateSceneCode(app, {
          script,
          scene,
          index,
          durationMs: estimateNarrationMs(scene.narration),
          durationIsEstimate: true,
        }).catch((err): SceneCodeResult => {
          app.log.error({ err, sceneId: scene.id }, "Scene code draft threw");
          return { source: null, attempts: ["model call failed"] };
        }),
      )
    : [];

  // Narrating each scene on its own is what fixes the sync: from here on,
  // every duration is measured rather than estimated.
  const narrationBatch = await narrateScenes(app, req.userId, script.scenes);
  endStage("narrateMs");
  if (!narrationBatch.narrations) {
    app.log.warn({ pending: narrationBatch.pending }, "Lesson narration incomplete");
    return null;
  }
  const narrations = narrationBatch.narrations;
  const { timings, totalMs } = buildTimeline(narrations);

  // Copy narration out of uploads/ (swept after 24h) while the scenes render —
  // it is independent of them, and a saved lesson must not point there.
  const durableAudio = Promise.all(narrations.map((n) => storeNarration(app, n)));

  // [3] Render. Scenes run CONCURRENTLY. They used to go one at a time on the
  // theory that the render semaphore made parallelism pointless — but each
  // scene is a code-generation model call first, typically slower than the
  // render itself, and that call was waiting in line for no reason. The
  // semaphore inside render.service still caps heavy media work at
  // MANIM_MAX_CONCURRENT; the extra workers only let code-gen get ahead of it.
  const sceneJobs = script.scenes
    .map((scene, index) => ({ scene, index, narration: narrations[index], timing: timings[index] }))
    .filter((job): job is typeof job & { narration: SceneNarration; timing: SceneTiming } =>
      Boolean(job.narration && job.timing),
    );

  const built: BuiltScene[] = await mapConcurrent(sceneJobs, env.MANIM_MAX_CONCURRENT + 2, ({ scene, index, narration, timing }) =>
    rendererReady
      ? buildScene(app, { userId: req.userId, script, scene, index, narration, timing, firstDraft: firstDrafts[index] })
      : Promise.resolve<BuiltScene>({
          view: {
            id: scene.id,
            startMs: timing.startMs,
            durationMs: timing.durationMs,
            audioUrl: narration.audioUrl,
            narration: scene.narration,
            beats: placeBeats(scene, timing),
          },
        }),
  );
  endStage("renderMs");

  const renderedSceneCount = built.filter((b) => b.view.videoUrl).length;

  // [4] Assemble the downloadable file — only when every scene has video
  // bytes. A partial reel would be a file with holes in it, and the
  // interactive player is unaffected either way.
  const withBuffers = built.filter((b): b is BuiltScene & { videoBuffer: Buffer } => Boolean(b.videoBuffer));
  const lessonFile =
    withBuffers.length === built.length && built.length > 0
      ? await assembleLessonFile(app, {
          scenes: withBuffers.map((b) => ({ sceneId: b.view.id, videoBuffer: b.videoBuffer })),
          narrations,
          timings,
        })
      : null;
  endStage("assembleMs");

  // Swap each scene's audio to its durable copy where that succeeded. The
  // response works either way (uploads/ is fine for today); only a lesson
  // whose narration is ALL durable gets its payload saved.
  const audioUrls = await durableAudio;
  const allAudioDurable = audioUrls.every((url) => url !== null);
  const scenes = built.map((b) => {
    const index = narrations.findIndex((n) => n.sceneId === b.view.id);
    const durable = index >= 0 ? audioUrls[index] : null;
    return durable ? { ...b.view, audioUrl: durable } : b.view;
  });

  const payload: LessonPayload = {
    title: script.title,
    conceptKey: script.conceptKey,
    scenes,
    ...(lessonFile ? { lessonUrl: lessonFile.url } : {}),
    totalDurationMs: totalMs,
    timestampManifest: concatTimestamps(narrations, timings),
    reused: false,
    renderedSceneCount,
  };

  // [5] Save it — every playable build, not just a flawless one. Only saving
  // lessons where every scene rendered AND the MP4 assembled is what threw
  // away ~85% of builds: paid for, watched once, gone, and rebuilt from
  // scratch the next time the student tapped "watch". A lesson with fallback
  // scenes is kept as PARTIAL, replayable by the students who have seen it
  // but never shared (see library.service).
  const complete = built.length > 0 && renderedSceneCount === built.length;
  const storedPayload: StoredLessonPayload | null = allAudioDurable
    ? {
        title: payload.title,
        scenes: payload.scenes,
        ...(payload.lessonUrl ? { lessonUrl: payload.lessonUrl } : {}),
        totalDurationMs: payload.totalDurationMs,
        timestampManifest: payload.timestampManifest,
        renderedSceneCount,
      }
    : null;

  if (storedPayload || (complete && lessonFile)) {
    await publishLesson(app, {
      userId: req.userId,
      classLevel: req.classLevel,
      subject: req.subject,
      chapter: req.chapter,
      nodeId: req.nodeId ?? null,
      script,
      kind: complete ? LESSON_KIND : PARTIAL_KIND,
      url: lessonFile?.url ?? null,
      payload: storedPayload,
      durationSec: totalMs / 1000,
      costUsd: narrationBatch.totalCostUsd + 0.004,
    });
  } else {
    app.log.warn({ conceptKey: script.conceptKey }, "Lesson not saved — narration could not be stored durably");
  }
  endStage("publishMs");

  app.log.info(
    {
      conceptKey: script.conceptKey,
      scenes: built.length,
      renderedSceneCount,
      saved: complete ? LESSON_KIND : storedPayload ? PARTIAL_KIND : "no",
      totalMs: Date.now() - startedAt,
      ...stageMs,
    },
    "Lesson build finished",
  );

  return payload;
}

/* ── Public entry point ─────────────────────────────────────────────────────*/

function payloadFromLibrary(lesson: LibraryLesson): LessonPayload | null {
  if (!lesson.script) return null;

  // The stored payload is the whole lesson with durable URLs — a replay keeps
  // its captions, beats and pause-and-ask exactly as the first viewing had.
  if (lesson.payload) {
    return {
      ...lesson.payload,
      conceptKey: lesson.script.conceptKey,
      reused: true,
    };
  }

  // Rows from before the payload existed play as the assembled file: their
  // per-scene audio lived under uploads/ and has long been swept. Without the
  // script or a file there is nothing to play, so they miss and get rebuilt.
  if (!lesson.url) return null;
  return {
    title: lesson.script.title,
    conceptKey: lesson.script.conceptKey,
    scenes: [],
    lessonUrl: lesson.url,
    totalDurationMs: Math.round(lesson.durationSec * 1000),
    timestampManifest: [],
    reused: true,
    renderedSceneCount: lesson.script.scenes.length,
  };
}

/**
 * Returns the lesson if it exists or has finished building; otherwise starts
 * the build and reports `generating`.
 *
 * Order is the whole design: own build → library → budget → build. Each layer
 * is cheaper than the one after it, and the first two are ordered that way for
 * a specific reason spelled out below.
 */
export async function buildOrGetLesson(app: FastifyInstance, req: BuildRequest): Promise<BuildResult> {
  // 1. This process's own in-flight/just-finished build, BEFORE the library.
  //
  // Order matters and the obvious order is wrong. Checking the library first
  // means the poll that lands right after a build finishes finds the lesson
  // this student just paid for sitting on the shelf, and returns it through the
  // REUSE path — and for a row without a stored payload (or when saving the
  // payload failed) that carries no scenes, no per-scene audio, no beats and no
  // word manifest: a flat MP4 with no captions and no pause-and-ask. Checking
  // here first always hands them the rich payload their own build produced.
  const key = buildKey(req);
  const existing = inFlight.get(key);

  if (existing) {
    if (existing.result !== undefined) {
      return existing.result
        ? { lesson: existing.result, generating: false }
        : { lesson: null, generating: false, failed: existing.error ?? "lesson build failed" };
    }
    return { lesson: null, generating: true };
  }

  // 2. The shared library. Costs one embedding call and can save the entire build.
  const reusable = await findReusableLesson(app, {
    userId: req.userId,
    classLevel: req.classLevel,
    subject: req.subject,
    chapter: req.chapter,
    nodeId: req.nodeId,
    conceptKey: req.brief.conceptKey,
    wantsNewVariant: req.wantsNewVariant,
  }).catch((err) => {
    app.log.error(err, "Lesson library lookup failed");
    return null;
  });

  if (reusable) {
    const payload = payloadFromLibrary(reusable);
    if (payload) {
      await recordReuse(app, req.userId, reusable.id);
      return { lesson: payload, generating: false };
    }
  }

  // 3. The budget. Much smaller than it was — rendering is free and only
  // narration and the two model calls bill — but an unbounded loop against a
  // paid TTS endpoint is still a way to lose money.
  const budget = await checkBudget(app, req.userId);
  if (!budget.allowed) {
    app.log.info({ reason: budget.reason }, "Skipping lesson build — budget");
    return { lesson: null, generating: false, failed: budget.reason ?? "daily budget reached" };
  }

  // 4. Build, in the background.
  // The deadline RACES the build rather than wrapping it: a hung upstream call
  // cannot be cancelled from here, but it must not be allowed to pin the slot.
  // Losing the race records a failure, which is what lets the student's next
  // attempt start a fresh build instead of rejoining a dead one.
  const deadline = new Promise<LessonPayload | null>((resolve) => {
    setTimeout(() => resolve(null), BUILD_DEADLINE_MS).unref?.();
  });

  const slot: BuildSlot = {
    startedAt: Date.now(),
    promise: Promise.race([
      runBuild(app, req).catch((err) => {
        app.log.error(err, "Lesson build threw");
        return null;
      }),
      deadline,
    ]).then((result) => {
      const current = inFlight.get(key);
      if (current) {
        current.result = result;
        if (!result) current.error = "lesson build failed";
      }
      // Both outcomes are held, for different reasons and different lengths.
      // A SUCCESS is kept long enough that the poll following it lands. A
      // FAILURE is kept only briefly — long enough for the client that is
      // mid-poll to see the failure and stop (it polls every 10s), because
      // dropping the key immediately would make that very poll start a whole
      // new build and loop. Short enough that a student who tries again a
      // minute later gets a genuine retry rather than a cached error.
      const ttl = result ? RESULT_TTL_MS : FAILED_TTL_MS;
      setTimeout(() => inFlight.delete(key), ttl).unref?.();
      return result;
    }),
  };
  inFlight.set(key, slot);

  return { lesson: null, generating: true };
}
