import type { FastifyInstance } from "fastify";
import { env } from "../../config/env";
import { embedText } from "../../lib/openai";
import { searchLessonVideos } from "../../lib/vectorSearch";
import type { DirectedScript } from "./director.schema";
import type { LessonSceneView } from "./lesson-build.service";
import type { WordTiming } from "../speech/edge-speech.service";

/**
 * The shared lesson library and the spend ledger.
 *
 * Was `generation.service.ts`, and was the only file allowed to call
 * OpenRouter's `/videos`. That endpoint is gone: footage cost $0.03/s, could
 * not render a Bangla label, an arrow or an equation, and its fixed 4/6/8s
 * SKUs are what desynchronised every lesson (PLAN.md §0). Scenes are rendered
 * by Manim now, for nothing.
 *
 * What survives is the part that was always right: look for an existing lesson
 * before making a new one, and keep grade isolation on every lookup
 * (guardrail #4). What it stores changed — whole narrated LESSONS rather than
 * 4-8 second footage fragments — which makes a hit far more valuable, since it
 * now saves the director call, every TTS chunk and every render at once.
 */

/**
 * How close a stored lesson must be to the asked concept before it is reused.
 *
 * Unchanged from the footage era, and still deliberately conservative. The
 * trade is different now, though, and worth restating: a false positive shows
 * a student the wrong lesson, while a false negative costs a few cents and
 * some CPU rather than a dollar. That asymmetry argues for keeping this tight
 * rather than loosening it to chase the reuse rate.
 */
export const REUSE_SIMILARITY_THRESHOLD = 0.86;

/** Rows written before the Manim pipeline: 4-8s veo/wan fragments. Never reused as lessons. */
export const LEGACY_CLIP_KIND = "CLIP";
export const LESSON_KIND = "LESSON";
/**
 * A lesson where some scenes fell back to caption cards. Saved so the student
 * who waited for it can replay it, but never handed to anyone else: a fallback
 * is usually a transient render failure, and a fresh build for the next student
 * is the chance to produce a complete LESSON that then serves everybody.
 */
export const PARTIAL_KIND = "PARTIAL";

/**
 * What `LessonVideo.payload` holds — the lesson as the player consumes it, with
 * every URL in durable storage.
 */
export interface StoredLessonPayload {
  title: string;
  scenes: LessonSceneView[];
  lessonUrl?: string;
  totalDurationMs: number;
  timestampManifest: WordTiming[];
  renderedSceneCount: number;
}

function readStoredPayload(value: unknown): StoredLessonPayload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<StoredLessonPayload>;
  if (typeof p.title !== "string" || !Array.isArray(p.scenes) || p.scenes.length === 0) return null;
  if (typeof p.totalDurationMs !== "number" || !Array.isArray(p.timestampManifest)) return null;
  return p as StoredLessonPayload;
}

export interface LibraryLesson {
  id: string;
  kind: string;
  /** The assembled MP4, when there is one. */
  url: string | null;
  durationSec: number;
  /** The DirectedScript it was built from, so a hit can replay beats and captions without re-directing. */
  script: DirectedScript | null;
  /** The full playable lesson, when the row was written with one. */
  payload: StoredLessonPayload | null;
  reused: true;
}

function toLibraryLesson(row: {
  id: string;
  kind: string;
  url: string | null;
  durationSec: number;
  script: unknown;
  payload: unknown;
}): LibraryLesson {
  return {
    id: row.id,
    kind: row.kind,
    url: row.url,
    durationSec: row.durationSec,
    script: (row.script as DirectedScript | null) ?? null,
    payload: readStoredPayload(row.payload),
    reused: true,
  };
}

/** A row is only playable with a stored payload or an assembled file. */
function isPlayable(row: { url: string | null; payload: unknown }): boolean {
  return Boolean(row.url) || readStoredPayload(row.payload) !== null;
}

export interface LessonLookup {
  userId: string;
  classLevel: number;
  subject: string;
  chapter: number;
  nodeId?: string | null;
  conceptKey: string;
  /** True when the student explicitly asked for a different take. */
  wantsNewVariant?: boolean;
}

/* ── Budget ─────────────────────────────────────────────────────────────────
 * Still here, but guarding much less. Rendering is free; what remains billable
 * is narration and the two model calls, so a day's worth of lessons now costs
 * cents rather than dollars. The cap stays because an unbounded loop against a
 * paid TTS endpoint is still a way to lose money, and because removing a
 * working safety rail to celebrate a cost reduction would be a poor trade.
 */

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

export interface BudgetState {
  userSpentUsd: number;
  globalSpentUsd: number;
  allowed: boolean;
  reason?: string;
}

export async function checkBudget(app: FastifyInstance, userId: string): Promise<BudgetState> {
  const since = startOfToday();
  const [userAgg, globalAgg] = await Promise.all([
    app.prisma.mediaSpend.aggregate({ _sum: { costUsd: true }, where: { userId, createdAt: { gte: since } } }),
    app.prisma.mediaSpend.aggregate({ _sum: { costUsd: true }, where: { createdAt: { gte: since } } }),
  ]);

  const userSpentUsd = userAgg._sum.costUsd ?? 0;
  const globalSpentUsd = globalAgg._sum.costUsd ?? 0;

  if (globalSpentUsd >= env.VIDEO_DAILY_USD_GLOBAL) {
    return { userSpentUsd, globalSpentUsd, allowed: false, reason: "global daily video budget reached" };
  }
  if (userSpentUsd >= env.VIDEO_DAILY_USD_PER_USER) {
    return { userSpentUsd, globalSpentUsd, allowed: false, reason: "your daily video budget is spent" };
  }
  return { userSpentUsd, globalSpentUsd, allowed: true };
}

export type SpendKind = "TTS" | "DIRECTOR" | "SCENE_CODE" | "RENDER" | "VIDEO";

/**
 * Records one billable (or metered) event.
 *
 * RENDER rows are written with `costUsd: 0` and a `cpuMs` — they exist for the
 * meter that actually binds now (PLAN.md §9.3), so the zero-cost early return
 * below explicitly lets them through.
 */
export async function recordSpend(
  app: FastifyInstance,
  params: { userId?: string | null; kind: SpendKind; model: string; costUsd: number; cpuMs?: number },
): Promise<void> {
  if (params.costUsd <= 0 && params.cpuMs === undefined) return; // a cache hit is not an event
  await app.prisma.mediaSpend.create({
    data: {
      userId: params.userId ?? null,
      kind: params.kind,
      model: params.model,
      costUsd: params.costUsd,
      ...(params.cpuMs !== undefined ? { cpuMs: params.cpuMs } : {}),
    },
  });
}

/* ── Lookup ─────────────────────────────────────────────────────────────────*/

/**
 * Finds a lesson already in the library that teaches this concept.
 *
 * Two strategies, strongest first:
 *  1. by `nodeId` — when the turn is tied to a roadmap level, that id IS the
 *     concept, so no embedding and no threshold guesswork is involved;
 *  2. by meaning — embedding similarity within the same class/subject/chapter.
 *
 * `wantsNewVariant` doesn't skip the library: it only excludes what this
 * student has already seen. A second angle another student generated last week
 * is still free for this one, which is the whole point of sharing.
 */
export async function findReusableLesson(app: FastifyInstance, req: LessonLookup): Promise<LibraryLesson | null> {
  const seen = await app.prisma.lessonVideoView.findMany({
    where: { userId: req.userId },
    select: { videoId: true },
  });
  const seenIds = new Set(seen.map((v) => v.videoId));

  if (req.nodeId) {
    const candidates = await app.prisma.lessonVideo.findMany({
      where: { nodeId: req.nodeId, kind: LESSON_KIND },
      orderBy: { variantIndex: "asc" },
    });
    const unseen = candidates.filter((c) => !seenIds.has(c.id));
    const pick = unseen[0] ?? (req.wantsNewVariant ? null : candidates[0]);
    if (pick && isPlayable(pick)) return toLibraryLesson(pick);
  }

  // Exact concept match, before any embedding. Replaying a past turn sends the
  // very brief that built the lesson, so its conceptKey is identical — and
  // going through `embedText` for that meant a spent embedding quota (shared
  // with chat and ingestion) made every saved lesson unfindable, so it was
  // rebuilt from scratch. No threshold is involved: equal keys in the same
  // grade triple are the same concept.
  const exact = await app.prisma.lessonVideo.findMany({
    where: {
      classLevel: req.classLevel,
      subject: req.subject,
      chapter: req.chapter,
      conceptKey: req.conceptKey,
      kind: { in: [LESSON_KIND, PARTIAL_KIND] },
    },
    orderBy: { createdAt: "desc" },
  });
  const usable = exact.filter(
    (row) =>
      isPlayable(row) &&
      // A PARTIAL belongs to the students who have already been shown it.
      (row.kind === LESSON_KIND || seenIds.has(row.id)) &&
      (!req.wantsNewVariant || !seenIds.has(row.id)),
  );
  const exactPick = usable.find((row) => row.kind === LESSON_KIND) ?? usable[0];
  if (exactPick) return toLibraryLesson(exactPick);

  const queryEmbedding = await embedText(req.conceptKey);
  const matches = await searchLessonVideos(app, {
    classLevel: req.classLevel,
    subject: req.subject,
    chapter: req.chapter,
    queryEmbedding,
    excludeIds: req.wantsNewVariant ? [...seenIds] : [],
  });

  const best = matches.find(
    (m) => m.similarity >= REUSE_SIMILARITY_THRESHOLD && (!req.wantsNewVariant || !seenIds.has(m.id)),
  );
  if (!best) return null;

  // searchLessonVideos returns the match row, not the whole record; the script
  // is what a replay needs, so it is fetched here rather than widening that
  // query for every caller.
  const row = await app.prisma.lessonVideo.findUnique({ where: { id: best.id } });
  if (!row || row.kind !== LESSON_KIND || !isPlayable(row)) return null;
  return toLibraryLesson(row);
}

/** Records that this student has now seen this lesson, for the variant logic above. */
export async function markSeen(app: FastifyInstance, userId: string, videoId: string): Promise<void> {
  await app.prisma.lessonVideoView
    .upsert({ where: { userId_videoId: { userId, videoId } }, create: { userId, videoId }, update: {} })
    .catch(() => {
      /* a duplicate view is harmless */
    });
}

/** Bumps the reuse counter and marks the view — what a library hit does on its way out. */
export async function recordReuse(app: FastifyInstance, userId: string, videoId: string): Promise<void> {
  await Promise.all([
    app.prisma.lessonVideo.update({ where: { id: videoId }, data: { timesReused: { increment: 1 } } }),
    markSeen(app, userId, videoId),
  ]).catch((err) => app.log.error(err, "Failed to record lesson reuse"));
}

/* ── Publishing ─────────────────────────────────────────────────────────────*/

export interface PublishLessonParams {
  userId: string;
  classLevel: number;
  subject: string;
  chapter: number;
  nodeId?: string | null;
  script: DirectedScript;
  /** LESSON when every scene rendered, PARTIAL otherwise. */
  kind: typeof LESSON_KIND | typeof PARTIAL_KIND;
  /** The assembled MP4, when one could be built. */
  url: string | null;
  payload: StoredLessonPayload | null;
  durationSec: number;
  /** What this lesson cost to make — director + scene code + narration. Rendering contributes nothing. */
  costUsd: number;
}

/**
 * Shelves a finished lesson so the next student gets it for free — or, for a
 * PARTIAL one, so at least the student who built it never loses it.
 *
 * The embedding is what makes it findable by meaning later, and it is written
 * with `$executeRaw` because Prisma's client cannot bind a `vector` literal —
 * the same constraint ingestion.service.ts documents. A lesson that fails to
 * embed is still reusable by `nodeId`; it just won't be found semantically,
 * which is worth logging and not worth failing over.
 */
export async function publishLesson(app: FastifyInstance, params: PublishLessonParams): Promise<string | null> {
  try {
    // Counted across BOTH kinds: `@@unique([nodeId, variantIndex])` spans every
    // row, so numbering LESSONs alone would collide with a PARTIAL's index.
    const variantIndex = params.nodeId
      ? await app.prisma.lessonVideo.count({ where: { nodeId: params.nodeId } })
      : await app.prisma.lessonVideo.count({
          where: {
            classLevel: params.classLevel,
            subject: params.subject,
            chapter: params.chapter,
            conceptKey: params.script.conceptKey,
            kind: { in: [LESSON_KIND, PARTIAL_KIND] },
          },
        });

    const created = await app.prisma.lessonVideo.create({
      data: {
        classLevel: params.classLevel,
        subject: params.subject,
        chapter: params.chapter,
        nodeId: params.nodeId ?? null,
        conceptKey: params.script.conceptKey,
        kind: params.kind,
        sceneCount: params.script.scenes.length,
        script: params.script as unknown as object,
        ...(params.payload ? { payload: params.payload as unknown as object } : {}),
        variantIndex,
        model: `manim-${env.MANIM_QUALITY}`,
        durationSec: Math.round(params.durationSec),
        resolution: { l: "480p", m: "720p", h: "1080p" }[env.MANIM_QUALITY],
        url: params.url,
        costUsd: params.costUsd,
      },
    });

    try {
      const embedding = await embedText(params.script.conceptKey);
      await app.prisma.$executeRaw`
        UPDATE "LessonVideo" SET embedding = ${`[${embedding.join(",")}]`}::vector WHERE id = ${created.id}`;
    } catch (err) {
      app.log.error(err, "Failed to embed lesson — semantic reuse unavailable for this one");
    }

    await markSeen(app, params.userId, created.id);
    return created.id;
  } catch (err) {
    app.log.error(err, "Failed to publish lesson to the library");
    return null;
  }
}
