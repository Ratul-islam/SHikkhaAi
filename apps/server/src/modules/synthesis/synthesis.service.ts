import type { FastifyInstance } from "fastify";
import { Prisma } from "@shikkha-ai/database";
import { chatClient, CHAT_MODEL } from "../../lib/openai";
import type { DraftLevel, SynthesizeLevelsBody, SynthesizeLevelsResponse } from "./synthesis.schema";
import { SYNTHESIS_JSON_SCHEMA } from "./synthesis.schema";

export class NoContentError extends Error {}
export class SynthesisFailedError extends Error {}

const MIN_LEVELS = 3;
const MAX_LEVELS = 8;
const DEFAULT_XP = 100;

/** Roughly the amount of chapter text we'll hand a single model call. */
const WINDOW_CHAR_BUDGET = 6000;

/**
 * Hard cap on map-step calls. The provider bills a per-model-name daily request
 * cap (see lib/openai.ts and CLAUDE.md guardrail #7), so synthesizing one
 * chapter must not be able to burn the whole day's budget. Chapters longer than
 * this get evenly-sampled windows rather than exhaustive coverage — the reduce
 * step is choosing level boundaries, which survives sampling; it isn't
 * extracting facts, which wouldn't.
 */
const MAX_SUMMARY_WINDOWS = 5;

interface PageChunk {
  content: string;
  page: number | null;
}

interface Window {
  text: string;
  pages: number[];
}

function pageOf(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const page = (metadata as Record<string, unknown>).page;
  return typeof page === "number" ? page : null;
}

/** Packs page-ordered chunks into windows of ~WINDOW_CHAR_BUDGET, never splitting a chunk. */
export function buildWindows(chunks: PageChunk[]): Window[] {
  const windows: Window[] = [];
  let text = "";
  let pages = new Set<number>();

  for (const chunk of chunks) {
    if (text.length > 0 && text.length + chunk.content.length > WINDOW_CHAR_BUDGET) {
      windows.push({ text, pages: [...pages].sort((a, b) => a - b) });
      text = "";
      pages = new Set<number>();
    }
    text += (text ? "\n\n" : "") + chunk.content;
    if (chunk.page !== null) pages.add(chunk.page);
  }
  if (text) windows.push({ text, pages: [...pages].sort((a, b) => a - b) });

  return windows;
}

/** Evenly samples down to `max` windows, always keeping the first and last so the chapter's arc is preserved. */
export function sampleWindows(windows: Window[], max: number): Window[] {
  if (windows.length <= max) return windows;
  const step = (windows.length - 1) / (max - 1);
  const picked: Window[] = [];
  for (let i = 0; i < max; i++) {
    const w = windows[Math.round(i * step)];
    if (w && !picked.includes(w)) picked.push(w);
  }
  return picked;
}

async function summarizeWindow(window: Window, subject: string, classLevel: number): Promise<string> {
  const pageRange = window.pages.length > 0 ? `pages ${window.pages[0]}–${window.pages[window.pages.length - 1]}` : "unknown pages";

  const completion = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You are analyzing an NCTB Class ${classLevel} ${subject} textbook chapter to help split it into teachable roadmap levels. Summarize the passage below into a compact outline of the distinct concepts it teaches, in the order they appear. Name concepts, don't explain them. No preamble.`,
      },
      { role: "user", content: `[${pageRange}]\n\n${window.text}` },
    ],
  });

  return `[${pageRange}] ${completion.choices[0]?.message?.content?.trim() ?? ""}`;
}

function buildSynthesisPrompt(params: {
  subject: string;
  classLevel: number;
  chapter: number;
  outline: string;
  availablePages: number[];
}): string {
  const { subject, classLevel, chapter, outline, availablePages } = params;
  const pageHint =
    availablePages.length > 0
      ? `Valid page numbers for this chapter run from ${availablePages[0]} to ${availablePages[availablePages.length - 1]}.`
      : "No page numbers are available for this chapter — return an empty sourcePages array for every level.";

  return `You are designing the roadmap for one chapter of the Bangladeshi NCTB curriculum: Class ${classLevel} ${subject}, Chapter ${chapter}.

Split this chapter into between ${MIN_LEVELS} and ${MAX_LEVELS} sequential roadmap levels. A level is one sitting's worth of learning — a single coherent idea a student can learn and then be tested on. Not a whole chapter, not a single sentence.

Rules:
- Order the levels the way they should be learned, easiest and most foundational first.
- \`tempKey\` is a short unique id you invent for each level, e.g. "n1", "n2". Use it consistently.
- \`prerequisiteKeys\` lists the tempKeys of levels that must be completed first. Keep these WITHIN this chapter — do not invent keys for other chapters. Most levels should depend on the one before it; the first level has none. Never create a cycle.
- \`title\` is short and student-facing (under 60 characters). Write it the way a curious student would think about the idea, not the way a syllabus index would list it.
- \`description\` is one or two sentences on what the student will be able to do after this level.
- \`sourcePages\` lists the textbook pages this level draws on. ${pageHint}
- Write the titles and descriptions in the same language the outline below is written in.

Chapter outline:
${outline}`;
}

interface RawLevel {
  tempKey: string;
  title: string;
  description: string;
  prerequisiteKeys: string[];
  sourcePages?: number[];
}

function validateLevels(raw: unknown): RawLevel[] {
  if (!raw || typeof raw !== "object") return [];
  const levels = (raw as Record<string, unknown>).levels;
  if (!Array.isArray(levels)) return [];

  return levels.filter((l): l is RawLevel => {
    if (!l || typeof l !== "object") return false;
    const v = l as Record<string, unknown>;
    if (typeof v.tempKey !== "string" || !v.tempKey.trim()) return false;
    if (typeof v.title !== "string" || !v.title.trim()) return false;
    if (typeof v.description !== "string") return false;
    return Array.isArray(v.prerequisiteKeys) && v.prerequisiteKeys.every((k) => typeof k === "string");
  });
}

/**
 * Drops prerequisite references the model invented (keys not present in the
 * draft), and any that would form a cycle. The commit endpoint rejects bad
 * graphs outright, but a draft an admin can actually read and edit is more
 * useful than an error — so clean it here and let them see the result.
 */
export function sanitizePrerequisites(levels: RawLevel[]): RawLevel[] {
  const known = new Set(levels.map((l) => l.tempKey));
  const indexByKey = new Map(levels.map((l, i) => [l.tempKey, i]));

  return levels.map((level, i) => ({
    ...level,
    prerequisiteKeys: level.prerequisiteKeys.filter((key) => {
      if (!known.has(key) || key === level.tempKey) return false;
      // Levels are emitted in learning order, so a prerequisite that appears
      // later in the list is either a cycle or simply wrong. Either way, drop it.
      const target = indexByKey.get(key);
      return target !== undefined && target < i;
    }),
  }));
}

/**
 * Level Synthesis: reads an ingested chapter out of DocumentChunk and proposes
 * a set of roadmap levels for admin review.
 *
 * Nothing is persisted here — a hallucinated curriculum node is worse than no
 * node, so committing is a separate, explicitly-approved step
 * (POST /api/v1/admin/nodes/bulk).
 */
export async function synthesizeLevels(
  app: FastifyInstance,
  { classLevel, subject, chapter }: SynthesizeLevelsBody,
): Promise<SynthesizeLevelsResponse> {
  // Ordered by page so the outline follows the chapter's own teaching order.
  // Raw SQL because the page lives inside the metadata JSON column.
  const rows = await app.prisma.$queryRaw<{ content: string; metadata: unknown }[]>(
    Prisma.sql`
      SELECT content, metadata
      FROM "DocumentChunk"
      WHERE "classLevel" = ${classLevel}
        AND "subject" = ${subject}
        AND "chapter" = ${chapter}
      ORDER BY COALESCE((metadata->>'page')::int, 0) ASC, id ASC
    `,
  );

  if (rows.length === 0) {
    throw new NoContentError(
      `No ingested content found for Class ${classLevel} ${subject} chapter ${chapter}. Upload the PDF first.`,
    );
  }

  const chunks: PageChunk[] = rows.map((r) => ({ content: r.content, page: pageOf(r.metadata) }));
  const allPages = [...new Set(chunks.map((c) => c.page).filter((p): p is number => p !== null))].sort(
    (a, b) => a - b,
  );

  const windows = buildWindows(chunks);
  const sampled = sampleWindows(windows, MAX_SUMMARY_WINDOWS);

  // A chapter small enough to fit one window needs no map step — skip straight
  // to synthesis and spend one request instead of two.
  const outline =
    sampled.length === 1 && windows.length === 1
      ? sampled[0]!.text
      : (await Promise.all(sampled.map((w) => summarizeWindow(w, subject, classLevel)))).join("\n\n");

  let parsed: unknown;
  try {
    const completion = await chatClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        {
          role: "system",
          content: buildSynthesisPrompt({ subject, classLevel, chapter, outline, availablePages: allPages }),
        },
        { role: "user", content: `Propose the roadmap levels for this chapter now.` },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "chapter_levels", schema: SYNTHESIS_JSON_SCHEMA },
      },
    });
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "");
  } catch (err) {
    throw new SynthesisFailedError(`Level synthesis call failed: ${(err as Error).message}`);
  }

  const valid = sanitizePrerequisites(validateLevels(parsed));
  if (valid.length === 0) {
    throw new SynthesisFailedError("Model returned no usable levels for this chapter");
  }

  const pageSet = new Set(allPages);
  const draft: DraftLevel[] = valid.slice(0, MAX_LEVELS).map((level, i) => ({
    tempKey: level.tempKey,
    title: level.title.trim(),
    description: level.description.trim(),
    orderIndex: i,
    prerequisiteKeys: level.prerequisiteKeys,
    totalXp: DEFAULT_XP,
    // Keep only pages that actually exist in the ingested chapter — the model
    // will otherwise cite plausible-looking page numbers it never saw.
    sourcePages: (level.sourcePages ?? []).filter((p) => pageSet.has(p)),
  }));

  const existingNodeCount = await app.prisma.curriculumNode.count({
    where: { classLevel, subject, chapterNumber: chapter },
  });

  return { classLevel, subject, chapter, chunksAnalyzed: rows.length, existingNodeCount, draft };
}
