import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Prisma } from "@shikkha-ai/database";
import { embedTexts } from "../../lib/openai";
import { env } from "../../config/env";

/**
 * The only module that writes DocumentChunk. Prisma's generated client can't
 * bind a `vector` literal, so writes go through `$executeRaw` here rather than
 * scattering raw SQL. Pages are read and structured elsewhere
 * (page-reader.service.ts, structure.service.ts); this module chunks, embeds
 * and replaces a committed chapter's content.
 */

const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;
const EMBED_BATCH_SIZE = 20;
const INSERT_BATCH_SIZE = 50;
const EMBED_WINDOW_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 8;

export interface TextChunk {
  content: string;
  page: number;
}

/** Splits one page's text into ~800-char chunks with 100-char overlap. Pure, unit-testable. */
export function chunkPageText(text: string, page: number): TextChunk[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const chunks: TextChunk[] = [];
  let start = 0;

  while (start < clean.length) {
    const end = Math.min(start + CHUNK_SIZE, clean.length);
    const content = clean.slice(start, end).trim();
    if (content) chunks.push({ content, page });
    if (end === clean.length) break;
    start = end - CHUNK_OVERLAP;
  }

  return chunks;
}

/*
 * Google AI Studio's free tier meters embeddings PER INPUT, per minute —
 * measured: a 429 at 100 inputs/minute for gemini-embedding-001, however they
 * are batched. A whole book is ~1,300 chunks, so bulk embedding is paced under
 * INGEST_EMBED_PER_MINUTE, and a 429 waits out the server's own retry delay
 * instead of failing the chapter. Chat's one embed per turn shares this quota,
 * which is why the default pace leaves headroom.
 */
const embedsInWindow: { at: number; count: number }[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEmbedBudget(count: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (embedsInWindow.length > 0 && now - embedsInWindow[0]!.at >= EMBED_WINDOW_MS) embedsInWindow.shift();
    const used = embedsInWindow.reduce((sum, e) => sum + e.count, 0);
    if (embedsInWindow.length === 0 || used + count <= env.INGEST_EMBED_PER_MINUTE) {
      embedsInWindow.push({ at: now, count });
      return;
    }
    await sleep(EMBED_WINDOW_MS - (now - embedsInWindow[0]!.at) + 50);
  }
}

/**
 * The free tier also caps embeddings per DAY (measured: 1,000). That 429 says
 * "retry in 56s" like the per-minute one, but waiting can't clear it — it's
 * told apart by the quota id in the error body.
 */
export function isDailyEmbedQuotaError(err: unknown): boolean {
  if ((err as { status?: number }).status !== 429) return false;
  return /PerDay/i.test(JSON.stringify((err as { error?: unknown }).error ?? ""));
}

/** The wait a per-minute 429 asks for ("Please retry in 26.02s"); null for any other error, including the daily quota. */
function rateLimitDelayMs(err: unknown): number | null {
  if ((err as { status?: number }).status !== 429 || isDailyEmbedQuotaError(err)) return null;
  const match = /retry in ([\d.]+)s/i.exec((err as Error).message ?? "");
  return match ? Math.ceil(Number(match[1]) * 1000) + 1000 : 30_000;
}

async function embedChunksInBatches(
  chunks: TextChunk[],
  onProgress?: (embedded: number) => Promise<void>,
): Promise<number[][]> {
  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    for (let attempt = 0; ; attempt++) {
      await waitForEmbedBudget(batch.length);
      try {
        embeddings.push(...(await embedTexts(batch.map((c) => c.content))));
        break;
      } catch (err) {
        const delay = rateLimitDelayMs(err);
        if (delay === null || attempt >= MAX_RATE_LIMIT_RETRIES) throw err;
        await onProgress?.(embeddings.length);
        await sleep(delay);
      }
    }
    await onProgress?.(embeddings.length);
  }
  return embeddings;
}

export interface TopicChunk extends TextChunk {
  topicCode: string | null;
}

/** Chunks per-topic segments with the same 800/100 window as everything else, carrying each segment's topic. */
export function chunkSegments(segments: { topicCode: string | null; page: number; text: string }[]): TopicChunk[] {
  return segments.flatMap((s) => chunkPageText(s.text, s.page).map((c) => ({ ...c, topicCode: s.topicCode })));
}

export interface ChapterContent {
  classLevel: number;
  subject: string;
  jobId: string | null;
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  topics: { code: string; title: string; startPage: number; endPage: number }[];
  chunks: TopicChunk[];
}

/**
 * Replaces one chapter wholesale — its Chapter row, topics and every chunk for
 * its classLevel/subject/chapter triple — in a single transaction, so
 * re-committing a book (or re-uploading it) never duplicates content and a
 * failure never leaves a half-written chapter. Embedding happens first, outside
 * the transaction: it's the slow, quota-bound step.
 */
export async function replaceChapterContent(
  app: FastifyInstance,
  content: ChapterContent,
  options: { onEmbedProgress?: (embedded: number) => Promise<void> } = {},
): Promise<number> {
  const { classLevel, subject, number } = content;
  const embeddings = await embedChunksInBatches(content.chunks, options.onEmbedProgress);
  if (embeddings.length !== content.chunks.length) {
    throw new Error("Embedding/chunk count mismatch during ingestion");
  }

  const where = { classLevel_subject_number: { classLevel, subject, number } };
  const existing = await app.prisma.chapter.findUnique({ where, select: { id: true } });
  // Ids are minted here rather than read back, so the whole replacement fits
  // one batch transaction (chunk rows need their topic's id).
  const chapterId = existing?.id ?? randomUUID();
  const topics = content.topics.map((t, i) => ({ id: randomUUID(), chapterId, orderIndex: i, ...t }));
  const topicIdByCode = new Map(topics.map((t) => [t.code, t.id]));

  const inserts: Prisma.PrismaPromise<number>[] = [];
  for (let i = 0; i < content.chunks.length; i += INSERT_BATCH_SIZE) {
    const rows = content.chunks.slice(i, i + INSERT_BATCH_SIZE).map((chunk, idx) => {
      const vectorLiteral = `[${embeddings[i + idx]!.join(",")}]`;
      const topicId = chunk.topicCode ? (topicIdByCode.get(chunk.topicCode) ?? null) : null;
      const metadata = JSON.stringify({ page: chunk.page, topic: chunk.topicCode });
      return Prisma.sql`(${randomUUID()}, ${chunk.content}, ${classLevel}, ${subject}, ${number}, ${topicId}, ${vectorLiteral}::vector, ${metadata}::jsonb, now())`;
    });
    inserts.push(
      app.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "DocumentChunk" (id, content, "classLevel", subject, chapter, "topicId", embedding, metadata, "createdAt")
        VALUES ${Prisma.join(rows)}
      `),
    );
  }

  const chapterData = {
    title: content.title,
    startPage: content.startPage,
    endPage: content.endPage,
    jobId: content.jobId,
  };
  await app.prisma.$transaction([
    app.prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "classLevel" = ${classLevel} AND subject = ${subject} AND chapter = ${number}`,
    app.prisma.topic.deleteMany({ where: { chapterId } }),
    app.prisma.chapter.upsert({
      where,
      create: { id: chapterId, classLevel, subject, number, ...chapterData },
      update: chapterData,
    }),
    app.prisma.topic.createMany({ data: topics }),
    ...inserts,
  ]);

  return content.chunks.length;
}

/** Removes a chapter, its topics (cascade) and every chunk for its triple. */
export async function deleteChapterContent(app: FastifyInstance, chapterId: string): Promise<boolean> {
  const chapter = await app.prisma.chapter.findUnique({ where: { id: chapterId } });
  if (!chapter) return false;
  await app.prisma.$transaction([
    app.prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "classLevel" = ${chapter.classLevel} AND subject = ${chapter.subject} AND chapter = ${chapter.number}`,
    app.prisma.chapter.delete({ where: { id: chapterId } }),
  ]);
  return true;
}
