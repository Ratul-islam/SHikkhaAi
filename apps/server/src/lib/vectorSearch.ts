import type { FastifyInstance } from "fastify";
import { Prisma } from "@shikkha-ai/database";

export interface DocumentChunkMatch {
  content: string;
  metadata: unknown;
}

export interface VectorSearchParams {
  /** Required, non-optional metadata filters — never skip these (CLAUDE.md RAG guardrail). */
  classLevel: number;
  subject: string;
  chapter: number;
  queryEmbedding: number[];
  limit?: number;
  /**
   * Optional narrowing INSIDE the required triple: the topic's chunks are
   * searched first, then the rest of the chapter tops the results up — so a
   * narrow or thinly-covered topic still gets full context, and a topicId can
   * only ever narrow, never widen, what's searched.
   */
  topicId?: string;
}

export interface IngestedChapter {
  subject: string;
  chapter: number;
}

/**
 * Every (subject, chapter) with ingested content for one grade — metadata
 * only, no chunk content. Lives here to keep this file the sole reader of
 * DocumentChunk; `classLevel` is required for the same isolation reason as
 * the search below.
 */
export async function listIngestedChapters(app: FastifyInstance, classLevel: number): Promise<IngestedChapter[]> {
  const groups = await app.prisma.documentChunk.groupBy({
    by: ["subject", "chapter"],
    where: { classLevel },
  });
  return groups.map((g) => ({ subject: g.subject, chapter: g.chapter }));
}

/**
 * Chunk counts per classLevel/subject/chapter, keyed "classLevel::subject::chapter"
 * — metadata only, for the admin content views.
 */
export async function countChunksByChapter(
  app: FastifyInstance,
  filter: { classLevel?: number; subject?: string },
): Promise<Map<string, number>> {
  const groups = await app.prisma.documentChunk.groupBy({
    by: ["classLevel", "subject", "chapter"],
    where: {
      ...(filter.classLevel ? { classLevel: filter.classLevel } : {}),
      ...(filter.subject ? { subject: filter.subject } : {}),
    },
    _count: { _all: true },
  });
  return new Map(groups.map((g) => [`${g.classLevel}::${g.subject}::${g.chapter}`, g._count._all]));
}

/**
 * Grade-isolated vector similarity search over DocumentChunk.
 *
 * classLevel/subject/chapter are always applied as strict, parameterized
 * WHERE filters — this is the sole point that queries DocumentChunk, so
 * every caller (chat, and future features) inherits the isolation.
 */
export async function searchDocumentChunks(
  app: FastifyInstance,
  { classLevel, subject, chapter, queryEmbedding, limit = 4, topicId }: VectorSearchParams,
): Promise<DocumentChunkMatch[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  const search = (scope: Prisma.Sql, take: number): Promise<DocumentChunkMatch[]> =>
    app.prisma.$queryRaw<DocumentChunkMatch[]>(
      Prisma.sql`
        SELECT content, metadata
        FROM "DocumentChunk"
        WHERE "classLevel" = ${classLevel}
          AND "subject" = ${subject}
          AND "chapter" = ${chapter}
          ${scope}
        ORDER BY embedding <=> ${vectorLiteral}::vector
        LIMIT ${take}
      `,
    );

  if (!topicId) return search(Prisma.empty, limit);

  const inTopic = await search(Prisma.sql`AND "topicId" = ${topicId}`, limit);
  if (inTopic.length >= limit) return inTopic;
  const rest = await search(Prisma.sql`AND ("topicId" IS NULL OR "topicId" <> ${topicId})`, limit - inTopic.length);
  return [...inTopic, ...rest];
}

/* ── The shared lesson-video library (PLAN.md §4) ────────────────────────────
 * Lives here rather than in the video module so it inherits this file's rule:
 * classLevel/subject/chapter are required parameters, not optional filters, so
 * a Class 9 student can never be served a Class 12 clip (CLAUDE.md guardrail #4).
 */

export interface LessonVideoMatch {
  id: string;
  url: string | null;
  conceptKey: string;
  variantIndex: number;
  durationSec: number;
  /** Cosine similarity in [0,1] — 1 is identical. */
  similarity: number;
}

export interface LessonVideoSearchParams {
  /** Required, non-optional metadata filters — never skip these. */
  classLevel: number;
  subject: string;
  chapter: number;
  queryEmbedding: number[];
  /** Variants this student has already been shown, excluded so "another example" finds something new. */
  excludeIds?: string[];
  limit?: number;
}

/**
 * Finds an existing clip that already teaches this concept, for reuse.
 *
 * Returns matches ordered best-first with their similarity, so the caller — not
 * this function — decides the threshold. That split is deliberate: the
 * threshold is a product judgement ("is a transistor clip close enough for a
 * diode question?") that will be tuned against real reuse data, and it should
 * not be buried in a query.
 */
export async function searchLessonVideos(
  app: FastifyInstance,
  { classLevel, subject, chapter, queryEmbedding, excludeIds = [], limit = 5 }: LessonVideoSearchParams,
): Promise<LessonVideoMatch[]> {
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  // `1 - (embedding <=> query)` converts pgvector's cosine DISTANCE into a
  // similarity, so callers reason in the direction they expect.
  const rows = await app.prisma.$queryRaw<LessonVideoMatch[]>(
    Prisma.sql`
      SELECT id, url, "conceptKey", "variantIndex", "durationSec",
             1 - (embedding <=> ${vectorLiteral}::vector) AS similarity
      FROM "LessonVideo"
      WHERE "classLevel" = ${classLevel}
        AND "subject" = ${subject}
        AND "chapter" = ${chapter}
        AND embedding IS NOT NULL
        -- Only complete lessons are shared by meaning. Filtering here rather
        -- than after the fact matters: a legacy CLIP or a PARTIAL ranked above
        -- a real LESSON used to take one of the LIMIT slots and hide it.
        AND kind = 'LESSON'
        ${excludeIds.length > 0 ? Prisma.sql`AND id <> ALL(${excludeIds})` : Prisma.empty}
      ORDER BY embedding <=> ${vectorLiteral}::vector
      LIMIT ${limit}
    `,
  );

  return rows;
}
