import { access, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { IngestionJob, IngestionPage, Prisma } from "@shikkha-ai/database";
import { env } from "../../config/env";
import { countChunksByChapter } from "../../lib/vectorSearch";
import { PageReadError, countPdfPages, readPageImage, renderPageToPng } from "./page-reader.service";
import type { PageReading } from "./page-reading";
import {
  buildChapterSegments,
  detectStructure,
  validateStructure,
  type PageOutline,
  type PageWithText,
} from "./structure.service";
import { chunkSegments, deleteChapterContent, isDailyEmbedQuotaError, replaceChapterContent } from "./ingestion.service";
import type {
  ChapterListQuery,
  ChapterView,
  DraftChapter,
  IngestionJobDetailResponse,
  IngestionJobStatus,
  IngestionJobSummary,
  IngestionPageView,
} from "./ingestion.schema";

/**
 * Whole-book ingestion as a background job: upload → read every page →
 * detected draft for admin review → commit (guardrail #11's draft-then-commit).
 *
 * Reading a 366-page book takes minutes, so nothing here runs on the request:
 * routes return at once and the admin panel polls, exactly like /video/build.
 * Progress lives in the database, which makes reading resumable — a restarted
 * server picks up interrupted jobs and only reads the pages still missing.
 */

export class JobNotFoundError extends Error {}
export class JobStateError extends Error {}
export class StructureInvalidError extends Error {}
export class InvalidPdfError extends Error {}

const PAGE_ATTEMPTS = 2;
const PREVIEW_DPI = 60;

/** Jobs with a reader or committer active in THIS process — guards against double-starting one. */
const active = new Set<string>();

function pdfPathFor(jobId: string): string {
  return path.join(env.INGEST_STORAGE_DIR, `${jobId}.pdf`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function toSummary(job: IngestionJob): IngestionJobSummary {
  return {
    id: job.id,
    fileName: job.fileName,
    classLevel: job.classLevel,
    subject: job.subject,
    status: job.status as IngestionJobStatus,
    pageCount: job.pageCount,
    pagesDone: job.pagesDone,
    pagesFailed: job.pagesFailed,
    costUsd: job.costUsd,
    chunksInserted: job.chunksInserted,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    committedAt: job.committedAt?.toISOString() ?? null,
  };
}

function headingsOf(value: Prisma.JsonValue): { code: string; title: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((h) => {
    if (!h || typeof h !== "object" || Array.isArray(h)) return [];
    const { code, title } = h as Record<string, unknown>;
    return typeof title === "string" ? [{ code: typeof code === "string" ? code : "", title }] : [];
  });
}

type OutlineRow = Pick<IngestionPage, "pageNumber" | "pageKind" | "chapterNumber" | "chapterTitle" | "runningHeader" | "headings">;

function toOutline(row: OutlineRow): PageOutline {
  return {
    pageNumber: row.pageNumber,
    pageKind: row.pageKind,
    chapterNumber: row.chapterNumber,
    chapterTitle: row.chapterTitle,
    runningHeader: row.runningHeader,
    headings: headingsOf(row.headings),
  };
}

async function getJobOrThrow(app: FastifyInstance, jobId: string): Promise<IngestionJob> {
  const job = await app.prisma.ingestionJob.findUnique({ where: { id: jobId } });
  if (!job) throw new JobNotFoundError("Ingestion job not found");
  return job;
}

/* ── Create & read ───────────────────────────────────────────────────────── */

export async function createJob(
  app: FastifyInstance,
  params: { fileName: string; classLevel: number; subject: string; buffer: Buffer },
): Promise<IngestionJobSummary> {
  await mkdir(env.INGEST_STORAGE_DIR, { recursive: true });
  const job = await app.prisma.ingestionJob.create({
    data: { fileName: params.fileName, classLevel: params.classLevel, subject: params.subject },
  });
  const pdfPath = pdfPathFor(job.id);

  let pageCount: number;
  try {
    await writeFile(pdfPath, params.buffer);
    pageCount = await countPdfPages(pdfPath);
  } catch (err) {
    await rm(pdfPath, { force: true });
    await app.prisma.ingestionJob.update({
      where: { id: job.id },
      data: { status: "FAILED", error: `Couldn't open the PDF: ${(err as Error).message}` },
    });
    throw new InvalidPdfError("That file couldn't be opened as a PDF");
  }

  const updated = await app.prisma.ingestionJob.update({ where: { id: job.id }, data: { pageCount } });
  startReading(app, job.id);
  return toSummary(updated);
}

function startReading(app: FastifyInstance, jobId: string): void {
  if (active.has(jobId)) return;
  active.add(jobId);
  void readPages(app, jobId)
    .catch(async (err: unknown) => {
      app.log.error({ err, jobId }, "Ingestion reading failed");
      await app.prisma.ingestionJob
        .update({ where: { id: jobId }, data: { status: "FAILED", error: (err as Error).message } })
        .catch(() => undefined);
    })
    .finally(() => active.delete(jobId));
}

async function readPages(app: FastifyInstance, jobId: string): Promise<void> {
  const job = await getJobOrThrow(app, jobId);
  const pdfPath = pdfPathFor(jobId);
  if (!(await fileExists(pdfPath))) throw new Error("The uploaded PDF is no longer stored — upload the book again.");

  const readable = await app.prisma.ingestionPage.findMany({
    where: { jobId, NOT: { pageKind: "failed" } },
    select: { pageNumber: true },
  });
  const done = new Set(readable.map((p) => p.pageNumber));
  const todo = Array.from({ length: job.pageCount }, (_, i) => i + 1).filter((n) => !done.has(n));

  await app.prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: "READING", error: null, pagesDone: done.size, pagesFailed: 0 },
  });

  const workDir = path.join(os.tmpdir(), "shikkha-ingest", jobId);
  await mkdir(workDir, { recursive: true });
  try {
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < todo.length) {
        const pageNumber = todo[next++]!;
        await readOnePage(app, jobId, pdfPath, workDir, pageNumber);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(env.INGEST_CONCURRENCY, todo.length)) }, worker));
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }

  // Recount from the rows rather than trusting the incremental counters.
  const [pagesDone, pagesFailed] = await Promise.all([
    app.prisma.ingestionPage.count({ where: { jobId, NOT: { pageKind: "failed" } } }),
    app.prisma.ingestionPage.count({ where: { jobId, pageKind: "failed" } }),
  ]);
  await app.prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: "READY_FOR_REVIEW", pagesDone, pagesFailed },
  });
}

async function readOnePage(
  app: FastifyInstance,
  jobId: string,
  pdfPath: string,
  workDir: string,
  pageNumber: number,
): Promise<void> {
  let costUsd = 0;
  let lastError = "";

  for (let attempt = 0; attempt < PAGE_ATTEMPTS; attempt++) {
    try {
      const png = await renderPageToPng(pdfPath, pageNumber, workDir);
      const result = await readPageImage(png);
      costUsd += result.costUsd;
      await savePage(app, jobId, pageNumber, result.reading, null);
      await app.prisma.ingestionJob.update({
        where: { id: jobId },
        data: { pagesDone: { increment: 1 }, costUsd: { increment: costUsd } },
      });
      return;
    } catch (err) {
      if (err instanceof PageReadError) costUsd += err.costUsd;
      lastError = (err as Error).message;
    }
  }

  // One unreadable page never fails the book — it's recorded for retry.
  app.log.warn({ jobId, pageNumber, error: lastError }, "Ingestion page failed");
  await savePage(app, jobId, pageNumber, null, lastError.slice(0, 500));
  await app.prisma.ingestionJob.update({
    where: { id: jobId },
    data: { pagesFailed: { increment: 1 }, costUsd: { increment: costUsd } },
  });
}

async function savePage(
  app: FastifyInstance,
  jobId: string,
  pageNumber: number,
  reading: PageReading | null,
  error: string | null,
): Promise<void> {
  const data = reading
    ? {
        pageKind: reading.pageKind,
        chapterNumber: reading.chapterNumber,
        chapterTitle: reading.chapterTitle,
        runningHeader: reading.runningHeader,
        printedPageNumber: reading.printedPageNumber,
        headings: reading.headings as unknown as Prisma.InputJsonValue,
        text: reading.text,
        error: null,
      }
    : {
        pageKind: "failed",
        chapterNumber: null,
        chapterTitle: null,
        runningHeader: "",
        printedPageNumber: null,
        headings: [] as unknown as Prisma.InputJsonValue,
        text: "",
        error,
      };
  await app.prisma.ingestionPage.upsert({
    where: { jobId_pageNumber: { jobId, pageNumber } },
    create: { jobId, pageNumber, ...data },
    update: data,
  });
}

export async function retryFailedPages(app: FastifyInstance, jobId: string): Promise<IngestionJobSummary> {
  const job = await getJobOrThrow(app, jobId);
  if (active.has(jobId) || !["READY_FOR_REVIEW", "FAILED"].includes(job.status)) {
    throw new JobStateError("Pages can only be retried once reading has finished.");
  }
  if (!(await fileExists(pdfPathFor(jobId)))) {
    throw new JobStateError("This book's PDF is no longer stored (it's removed after commit) — upload it again.");
  }
  startReading(app, jobId);
  return toSummary(job);
}

/** A reading or committing job touches its row every few seconds; one quiet this long has lost its worker. */
const STALE_AFTER_MS = 2 * 60_000;

/**
 * Picks up jobs a server restart interrupted. Reading resumes where it
 * stopped; a commit must be re-requested. Only stale jobs are touched — a job
 * still advancing is being worked by another process (a second server, a dev
 * reload racing the old one, verify:ingestion), and resuming it here would
 * read, and bill, every remaining page twice.
 */
export async function resumeInterruptedJobs(app: FastifyInstance): Promise<void> {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS);
  const [reading, committing] = await Promise.all([
    app.prisma.ingestionJob.findMany({
      where: { status: { in: ["QUEUED", "READING"] }, updatedAt: { lt: staleBefore } },
      select: { id: true },
    }),
    app.prisma.ingestionJob.updateMany({
      where: { status: "COMMITTING", updatedAt: { lt: staleBefore } },
      data: { status: "READY_FOR_REVIEW", error: "The server restarted during commit. Commit again — committed chapters are replaced, never duplicated." },
    }),
  ]);
  for (const { id } of reading) startReading(app, id);
  if (reading.length > 0 || committing.count > 0) {
    app.log.info({ resumedReading: reading.length, resetCommits: committing.count }, "Resumed interrupted ingestion jobs");
  }
}

/* ── Query ───────────────────────────────────────────────────────────────── */

export async function listJobs(app: FastifyInstance): Promise<IngestionJobSummary[]> {
  const jobs = await app.prisma.ingestionJob.findMany({ orderBy: { createdAt: "desc" }, take: 50 });
  return jobs.map(toSummary);
}

export async function getJobDetail(app: FastifyInstance, jobId: string): Promise<IngestionJobDetailResponse> {
  const job = await getJobOrThrow(app, jobId);

  const [pages, chapters, pdfAvailable] = await Promise.all([
    app.prisma.ingestionPage.findMany({
      where: { jobId },
      select: { pageNumber: true, pageKind: true, chapterNumber: true, chapterTitle: true, runningHeader: true, headings: true },
    }),
    app.prisma.chapter.findMany({
      where: { jobId },
      orderBy: { number: "asc" },
      include: { _count: { select: { topics: true } } },
    }),
    fileExists(pdfPathFor(jobId)),
  ]);

  const chunkCounts =
    chapters.length > 0 ? await countChunksByChapter(app, { classLevel: job.classLevel, subject: job.subject }) : new Map<string, number>();

  return {
    job: toSummary(job),
    draft: pages.length > 0 ? detectStructure(pages.map(toOutline)) : null,
    failedPages: pages.filter((p) => p.pageKind === "failed").map((p) => p.pageNumber).sort((a, b) => a - b),
    pageKinds: Array.from({ length: job.pageCount }, (_, i) => pages.find((p) => p.pageNumber === i + 1)?.pageKind ?? null),
    committedChapters: chapters.map((c) => ({
      id: c.id,
      number: c.number,
      title: c.title,
      startPage: c.startPage,
      endPage: c.endPage,
      topicCount: c._count.topics,
      chunkCount: chunkCounts.get(`${c.classLevel}::${c.subject}::${c.number}`) ?? 0,
    })),
    pdfAvailable,
  };
}

export async function getPage(app: FastifyInstance, jobId: string, pageNumber: number): Promise<IngestionPageView> {
  const row = await app.prisma.ingestionPage.findUnique({ where: { jobId_pageNumber: { jobId, pageNumber } } });
  if (!row) throw new JobNotFoundError("That page hasn't been read yet");
  return { ...toOutline(row), printedPageNumber: row.printedPageNumber, text: row.text, error: row.error };
}

/** A small render of one page for the review screen, while the PDF is still stored. */
export async function renderPagePreview(app: FastifyInstance, jobId: string, pageNumber: number): Promise<Buffer> {
  const job = await getJobOrThrow(app, jobId);
  const pdfPath = pdfPathFor(jobId);
  if (pageNumber > job.pageCount || !(await fileExists(pdfPath))) throw new JobNotFoundError("Page preview unavailable");
  const workDir = path.join(os.tmpdir(), "shikkha-ingest-preview", jobId);
  await mkdir(workDir, { recursive: true });
  return renderPageToPng(pdfPath, pageNumber, workDir, PREVIEW_DPI);
}

/* ── Commit & delete ─────────────────────────────────────────────────────── */

export async function commitJob(
  app: FastifyInstance,
  jobId: string,
  chapters: DraftChapter[],
): Promise<IngestionJobSummary> {
  const job = await getJobOrThrow(app, jobId);
  if (active.has(jobId) || !["READY_FOR_REVIEW", "COMMITTED"].includes(job.status)) {
    throw new JobStateError("This book can be committed once reading has finished.");
  }
  const problem = validateStructure(chapters, job.pageCount);
  if (problem) throw new StructureInvalidError(problem);

  const updated = await app.prisma.ingestionJob.update({
    where: { id: jobId },
    data: { status: "COMMITTING", error: null },
  });

  active.add(jobId);
  void commitChapters(app, job, chapters)
    .catch((err: unknown) => app.log.error({ err, jobId }, "Ingestion commit crashed"))
    .finally(() => active.delete(jobId));

  return toSummary(updated);
}

/**
 * The live chunk count of a chapter THIS job already published with exactly
 * this title, page range and topics — or null if anything differs. Such a
 * chapter is skipped on re-publish: replacing it would re-spend the daily
 * embedding quota for byte-identical content, which is how a book too big for
 * one day's quota could otherwise never finish publishing.
 */
function unchangedChunkCount(
  existing: { jobId: string | null; title: string; startPage: number; endPage: number; topics: { code: string; title: string; startPage: number; endPage: number }[] } | undefined,
  job: IngestionJob,
  chapter: DraftChapter,
  liveChunks: number,
): number | null {
  if (!existing || existing.jobId !== job.id || liveChunks === 0) return null;
  if (existing.title !== chapter.title.trim() || existing.startPage !== chapter.startPage || existing.endPage !== chapter.endPage) {
    return null;
  }
  const sameTopics =
    existing.topics.length === chapter.topics.length &&
    existing.topics.every((t, i) => {
      const d = chapter.topics[i]!;
      return t.code === d.code && t.title === d.title.trim() && t.startPage === d.startPage && t.endPage === d.endPage;
    });
  return sameTopics ? liveChunks : null;
}

async function commitChapters(app: FastifyInstance, job: IngestionJob, chapters: DraftChapter[]): Promise<void> {
  const ordered = [...chapters].sort((a, b) => a.number - b.number);
  const committed: number[] = [];
  let chunksInserted = 0;

  const [existingChapters, liveChunks] = await Promise.all([
    app.prisma.chapter.findMany({
      where: { classLevel: job.classLevel, subject: job.subject },
      include: { topics: { orderBy: { orderIndex: "asc" } } },
    }),
    countChunksByChapter(app, { classLevel: job.classLevel, subject: job.subject }),
  ]);
  const existingByNumber = new Map(existingChapters.map((c) => [c.number, c]));

  for (const chapter of ordered) {
    const unchanged = unchangedChunkCount(
      existingByNumber.get(chapter.number),
      job,
      chapter,
      liveChunks.get(`${job.classLevel}::${job.subject}::${chapter.number}`) ?? 0,
    );
    if (unchanged !== null) {
      chunksInserted += unchanged;
      committed.push(chapter.number);
      continue;
    }

    try {
      const rows = await app.prisma.ingestionPage.findMany({
        where: { jobId: job.id, pageNumber: { gte: chapter.startPage, lte: chapter.endPage } },
      });
      const pages: PageWithText[] = rows.map((r) => ({ ...toOutline(r), text: r.text }));
      const chunks = chunkSegments(buildChapterSegments(chapter, pages));
      chunksInserted += await replaceChapterContent(
        app,
        {
          classLevel: job.classLevel,
          subject: job.subject,
          jobId: job.id,
          number: chapter.number,
          title: chapter.title.trim(),
          startPage: chapter.startPage,
          endPage: chapter.endPage,
          topics: chapter.topics.map((t) => ({ ...t, title: t.title.trim() })),
          chunks,
        },
        {
          // A heartbeat while a big chapter is paced through the embedding
          // quota — minutes can pass, and a quiet row looks stale to resumeInterruptedJobs.
          onEmbedProgress: async () => {
            await app.prisma.ingestionJob.update({ where: { id: job.id }, data: { chunksInserted } });
          },
        },
      );
      committed.push(chapter.number);
      // Progress, and a heartbeat: keeps a long commit from looking stale to resumeInterruptedJobs.
      await app.prisma.ingestionJob.update({ where: { id: job.id }, data: { chunksInserted } });
    } catch (err) {
      app.log.error({ err, jobId: job.id, chapter: chapter.number }, "Committing a chapter failed");
      const done = committed.length > 0 ? `Chapters ${committed.join(", ")} are published. ` : "";
      const reason = isDailyEmbedQuotaError(err)
        ? `Chapter ${chapter.number} stopped because today's free embedding quota is used up. Publish again after it resets; unchanged published chapters are skipped, so only the rest are sent.`
        : `Chapter ${chapter.number} failed: ${(err as Error).message}. Publish again to retry; unchanged published chapters are skipped.`;
      await app.prisma.ingestionJob.update({
        where: { id: job.id },
        data: { status: "READY_FOR_REVIEW", chunksInserted, error: `${done}${reason}` },
      });
      return;
    }
  }

  await app.prisma.ingestionJob.update({
    where: { id: job.id },
    data: { status: "COMMITTED", chunksInserted, committedAt: new Date(), error: null },
  });
  // Every page's text is kept in IngestionPage, so a re-commit never needs the PDF.
  await rm(pdfPathFor(job.id), { force: true });
}

export async function deleteJob(app: FastifyInstance, jobId: string): Promise<void> {
  await getJobOrThrow(app, jobId);
  if (active.has(jobId)) throw new JobStateError("Wait for this book to finish reading or committing before deleting it.");
  // Committed chapters survive: Chapter.jobId is SET NULL, and their content stays live.
  await app.prisma.ingestionJob.delete({ where: { id: jobId } });
  await rm(pdfPathFor(jobId), { force: true });
}

export async function listChapters(app: FastifyInstance, query: ChapterListQuery): Promise<ChapterView[]> {
  const where = {
    ...(query.classLevel ? { classLevel: query.classLevel } : {}),
    ...(query.subject ? { subject: query.subject } : {}),
  };
  const [chapters, chunkCounts] = await Promise.all([
    app.prisma.chapter.findMany({
      where,
      orderBy: [{ classLevel: "asc" }, { subject: "asc" }, { number: "asc" }],
      include: { topics: { orderBy: { orderIndex: "asc" } } },
    }),
    countChunksByChapter(app, query),
  ]);
  return chapters.map((c) => ({
    id: c.id,
    classLevel: c.classLevel,
    subject: c.subject,
    number: c.number,
    title: c.title,
    startPage: c.startPage,
    endPage: c.endPage,
    jobId: c.jobId,
    chunkCount: chunkCounts.get(`${c.classLevel}::${c.subject}::${c.number}`) ?? 0,
    topics: c.topics.map((t) => ({ id: t.id, code: t.code, title: t.title, startPage: t.startPage, endPage: t.endPage })),
  }));
}

export async function deleteChapter(app: FastifyInstance, chapterId: string): Promise<void> {
  if (!(await deleteChapterContent(app, chapterId))) throw new JobNotFoundError("Chapter not found");
}
