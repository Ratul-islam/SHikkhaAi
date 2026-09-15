/**
 * Proves whole-book ingestion on a real PDF: creates a job, reads every page
 * with the vision model, and prints the detected chapters, topics, warnings
 * and measured cost.
 *
 *   npm run verify:ingestion --workspace=apps/server -- "<pdf>" <classLevel> <subject> [--commit]
 *   npm run verify:ingestion --workspace=apps/server -- --commit-job <jobId>
 *
 * The first form SPENDS real OpenRouter credit (~$0.0016 a page). Without
 * --commit nothing reaches Chapter/Topic/DocumentChunk: the job is left
 * READY_FOR_REVIEW, reviewable from the admin panel like any other upload.
 *
 * --commit (or --commit-job for a job that's already been read) commits the
 * structure as detected right now — re-detected from the stored pages, so a
 * detection fix applies without reading the book again. It REPLACES every
 * chunk for each detected chapter's classLevel/subject/chapter triple, and
 * embeds against the Google AI Studio quota.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import prismaPlugin from "../src/plugins/prisma";
import { commitJob, createJob, getJobDetail } from "../src/modules/ingestion/ingestion-job.service";
import type { IngestionJobDetailResponse } from "../src/modules/ingestion/ingestion.schema";

const POLL_MS = 10_000;

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printStructure(detail: IngestionJobDetailResponse): void {
  const draft = detail.draft;
  if (!draft) return out("  (no pages read)");
  out(`\n${draft.chapters.length} chapter(s):`);
  for (const c of draft.chapters) {
    out(`  Ch ${String(c.number).padStart(2)}  pp.${c.startPage}–${c.endPage}  "${c.title}"  · ${c.topics.length} topic(s)`);
    for (const t of c.topics) out(`         ${t.code.padEnd(6)} pp.${t.startPage}–${t.endPage}  ${t.title}`);
  }
  out(`\n${draft.warnings.length} warning(s):`);
  for (const w of draft.warnings) out(`  ! ${w}`);
}

async function readBook(app: FastifyInstance, pdf: string, classLevel: number, subject: string): Promise<IngestionJobDetailResponse> {
  const started = Date.now();
  const job = await createJob(app, { fileName: path.basename(pdf), classLevel, subject, buffer: await readFile(pdf) });
  out(`job ${job.id} · ${job.pageCount} pages · class ${job.classLevel} ${job.subject}`);

  let detail = await getJobDetail(app, job.id);
  while (detail.job.status === "QUEUED" || detail.job.status === "READING") {
    await sleep(POLL_MS);
    detail = await getJobDetail(app, job.id);
    const j = detail.job;
    out(`  ${j.pagesDone}/${j.pageCount} read · ${j.pagesFailed} failed · $${j.costUsd.toFixed(3)} · ${Math.round((Date.now() - started) / 1000)}s`);
  }
  if (detail.job.status === "FAILED") throw new Error(detail.job.error ?? "Reading failed");
  return detail;
}

async function commit(app: FastifyInstance, detail: IngestionJobDetailResponse): Promise<void> {
  if (!detail.draft || detail.draft.chapters.length === 0) throw new Error("Nothing detected to commit");
  const started = Date.now();
  await commitJob(app, detail.job.id, detail.draft.chapters);
  let current = detail;
  do {
    await sleep(POLL_MS / 2);
    current = await getJobDetail(app, detail.job.id);
    out(`  committing · ${current.job.chunksInserted} chunks · ${Math.round((Date.now() - started) / 1000)}s`);
  } while (current.job.status === "COMMITTING");
  if (current.job.status !== "COMMITTED") throw new Error(current.job.error ?? "Commit failed");
  out(`\n✓ Committed ${current.committedChapters.length} chapter(s), ${current.job.chunksInserted} chunks`);
  for (const c of current.committedChapters) {
    out(`  Ch ${String(c.number).padStart(2)}  ${String(c.chunkCount).padStart(4)} chunks · ${c.topicCount} topics · ${c.title}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commitJobIdx = args.indexOf("--commit-job");
  const existingJobId = commitJobIdx >= 0 ? args[commitJobIdx + 1] : undefined;

  const app = Fastify({ logger: { level: "warn" } });
  await app.register(prismaPlugin);
  await app.ready();

  try {
    if (commitJobIdx >= 0) {
      if (!existingJobId) throw new Error("Usage: verify:ingestion -- --commit-job <jobId>");
      const detail = await getJobDetail(app, existingJobId);
      printStructure(detail);
      await commit(app, detail);
      return;
    }

    const [pdf, classArg, subject] = args.filter((a) => !a.startsWith("--"));
    if (!pdf || !classArg || !subject) {
      throw new Error('Usage: verify:ingestion -- "<pdf>" <classLevel> <subject> [--commit]');
    }
    const detail = await readBook(app, pdf, Number(classArg), subject);
    printStructure(detail);
    out(`\n$${detail.job.costUsd.toFixed(3)} · failed pages: ${detail.failedPages.join(", ") || "none"}`);

    if (args.includes("--commit")) await commit(app, detail);
    else out(`\n✓ Job ${detail.job.id} left READY_FOR_REVIEW — nothing committed.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
