import type { DraftChapter, DraftStructure, DraftTopic } from "./ingestion.schema";
import type { PageHeading } from "./page-reading";

/**
 * Turns per-page readings of a whole textbook into chapters and topics, checks
 * an admin-edited structure before commit, and splits page text by topic.
 *
 * Pure — no I/O — so every heuristic is pinned by structure.service.test.ts.
 *
 * The signals, strongest first:
 *  1. a chapter-opening page ("Chapter Two / Motion") starts a chapter;
 *  2. a chapter with no detected opening is placed at its first numbered
 *     section ("5.1"), and flagged;
 *  3. running headers cross-check the result: odd pages carry the chapter's
 *     title, so a chapter whose pages mostly say something else is flagged.
 * Nothing is silently "fixed" — disagreements become warnings for the admin.
 */

export interface PageOutline {
  pageNumber: number;
  /** A PageKind, or "failed" for a page the reader couldn't read. */
  pageKind: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  runningHeader: string;
  headings: PageHeading[];
}

export interface PageWithText extends PageOutline {
  text: string;
}

export interface ContentSegment {
  topicCode: string | null;
  page: number;
  text: string;
}

/**
 * A topic is a two-level code ("1.3"); "1.3.1" stays inside topic 1.3. A
 * zero-padded second part ("1.01 Investigation", "2.03") is the book's own
 * numbering for investigation boxes and figures, never a section.
 */
const TOPIC_CODE = /^(\d+)\.([1-9]\d*)$/;
const ANY_SECTION_CODE = /^(\d+)\.[1-9]\d*(?:\.\d+)*$/;
/** A chapter opening routinely spans a title page and a picture page or two. */
const SAME_OPENING_MAX_GAP = 3;
const TITLE_STOP_WORDS = new Set(["a", "an", "and", "in", "of", "on", "the", "to"]);
/** A heading line in the transcribed Markdown that carries a topic code. Requires a heading/bold marker so "1.5 m/s" in a worked example never switches topic. */
const HEADING_LINE = /^\s*(?:#{1,6}\s+|\*\*)\s*(\d+\.\d+)(?![.\d])/;
const MAX_CHAPTER_NUMBER = 60;
const SKIPPED_KINDS = new Set(["front_matter", "blank", "failed"]);

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function titleWords(s: string): Set<string> {
  return new Set(
    normalize(s)
      .split(" ")
      .filter((w) => w && !TITLE_STOP_WORDS.has(w))
      .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w)),
  );
}

/** Running headers abbreviate titles ("Work, Power, Energy" for "Work, Power and Energy"), so compare words, not strings. */
export function titlesAgree(a: string, b: string): boolean {
  const wa = titleWords(a);
  const wb = titleWords(b);
  if (wa.size === 0 || wb.size === 0) return false;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / Math.min(wa.size, wb.size) >= 0.6;
}

/** "Heat and Temperature:" → "Heat and Temperature". */
function cleanTitle(title: string): string {
  return title.replace(/[:：]\s*$/, "").trim();
}

/** "3, 7–9, 12" — capped, since this goes into a warning line. */
export function formatPages(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i]!;
    let end = start;
    while (sorted[i + 1] === end + 1) end = sorted[++i]!;
    parts.push(start === end ? String(start) : `${start}–${end}`);
  }
  return parts.length > 10 ? `${parts.slice(0, 10).join(", ")}, …` : parts.join(", ");
}

interface ChapterStart {
  number: number;
  page: number;
  title: string;
  inferred: boolean;
}

export function detectStructure(pages: PageOutline[]): DraftStructure {
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber);
  const last = sorted[sorted.length - 1];
  if (!last) return { chapters: [], warnings: ["No pages have been read yet."] };

  const warnings: string[] = [];
  const failed = sorted.filter((p) => p.pageKind === "failed").map((p) => p.pageNumber);
  if (failed.length > 0) {
    warnings.push(
      `${failed.length} page(s) couldn't be read (${formatPages(failed)}). Retry them before committing, or their text will be missing.`,
    );
  }

  const starts = new Map<number, ChapterStart>();
  for (const p of sorted) {
    if (p.pageKind !== "chapter_opening" || p.chapterNumber === null) continue;
    const existing = starts.get(p.chapterNumber);
    if (!existing) {
      starts.set(p.chapterNumber, {
        number: p.chapterNumber,
        page: p.pageNumber,
        title: cleanTitle(p.chapterTitle ?? "") || `Chapter ${p.chapterNumber}`,
        inferred: false,
      });
    } else if (p.pageNumber - existing.page > SAME_OPENING_MAX_GAP) {
      warnings.push(
        `Chapter ${p.chapterNumber} seems to open twice (pages ${existing.page} and ${p.pageNumber}); page ${existing.page} was used.`,
      );
    }
  }

  const firstSectionPage = new Map<number, number>();
  for (const p of sorted) {
    for (const h of p.headings) {
      const m = ANY_SECTION_CODE.exec(h.code);
      if (!m) continue;
      const major = Number(m[1]);
      if (major >= 1 && major <= MAX_CHAPTER_NUMBER && !firstSectionPage.has(major)) firstSectionPage.set(major, p.pageNumber);
    }
  }
  for (const [major, page] of firstSectionPage) {
    if (starts.has(major)) continue;
    starts.set(major, { number: major, page, title: `Chapter ${major}`, inferred: true });
    warnings.push(
      `No opening page was found for chapter ${major}; it was placed at page ${page}, where its first numbered section appears. Check its start page and title.`,
    );
  }

  // Real openings win a tie on the same page over an inferred start.
  const ordered = [...starts.values()].sort((a, b) => a.page - b.page || Number(a.inferred) - Number(b.inferred));
  const unique: ChapterStart[] = [];
  for (const s of ordered) {
    if (unique[unique.length - 1]?.page !== s.page) unique.push(s);
  }

  if (unique.length === 0) {
    warnings.push("No chapters were detected. Add them manually before committing.");
    return { chapters: [], warnings };
  }

  for (let i = 1; i < unique.length; i++) {
    if (unique[i]!.number <= unique[i - 1]!.number) {
      warnings.push(`Chapter ${unique[i]!.number} comes after chapter ${unique[i - 1]!.number} in the book — check the numbering.`);
    }
  }
  const found = new Set(unique.map((s) => s.number));
  const maxNumber = Math.max(...found);
  const missing = Array.from({ length: maxNumber }, (_, i) => i + 1).filter((n) => !found.has(n));
  if (missing.length > 0) warnings.push(`Chapter(s) ${missing.join(", ")} weren't found.`);

  const chapters: DraftChapter[] = unique.map((s, i) => ({
    number: s.number,
    title: s.title,
    startPage: s.page,
    endPage: (unique[i + 1]?.page ?? last.pageNumber + 1) - 1,
    topics: [],
  }));

  applyRunningHeaders(chapters, sorted, unique, warnings);
  for (const chapter of chapters) chapter.topics = detectTopics(chapter, sorted);

  return { chapters, warnings };
}

function applyRunningHeaders(
  chapters: DraftChapter[],
  pages: PageOutline[],
  starts: ChapterStart[],
  warnings: string[],
): void {
  const perChapter = chapters.map((c) => {
    const counts = new Map<string, { raw: string; count: number }>();
    for (const p of pages) {
      if (p.pageNumber < c.startPage || p.pageNumber > c.endPage) continue;
      const key = normalize(p.runningHeader);
      if (!key) continue;
      const entry = counts.get(key);
      if (entry) entry.count++;
      else counts.set(key, { raw: p.runningHeader.trim(), count: 1 });
    }
    return counts;
  });

  // A header found across many chapters (the book's own name, "Physics") says
  // nothing about which chapter a page belongs to.
  const chapterHits = new Map<string, number>();
  for (const counts of perChapter) for (const key of counts.keys()) chapterHits.set(key, (chapterHits.get(key) ?? 0) + 1);
  const genericThreshold = Math.max(2, Math.ceil(chapters.length / 2));

  chapters.forEach((chapter, i) => {
    const top = [...perChapter[i]!.entries()]
      .filter(([key, v]) => (chapterHits.get(key) ?? 0) < genericThreshold && v.count >= 2)
      .sort((a, b) => b[1].count - a[1].count)[0];
    if (!top) return;
    if (starts[i]!.inferred) {
      chapter.title = top[1].raw;
      return;
    }
    if (!titlesAgree(top[1].raw, chapter.title)) {
      warnings.push(
        `Chapter ${chapter.number} "${chapter.title}": most of its pages are headed "${top[1].raw}". Check its title and page range.`,
      );
    }
  });
}

function detectTopics(chapter: DraftChapter, pages: PageOutline[]): DraftTopic[] {
  const topics: DraftTopic[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (p.pageNumber < chapter.startPage || p.pageNumber > chapter.endPage) continue;
    for (const h of p.headings) {
      const m = TOPIC_CODE.exec(h.code);
      if (!m || Number(m[1]) !== chapter.number || seen.has(h.code)) continue;
      seen.add(h.code);
      topics.push({ code: h.code, title: cleanTitle(h.title), startPage: p.pageNumber, endPage: chapter.endPage });
    }
  }
  // A topic ends on the page the next one starts — they routinely share it.
  for (let i = 0; i < topics.length - 1; i++) topics[i]!.endPage = topics[i + 1]!.startPage;
  return topics;
}

/** Semantic checks on an admin-edited structure; the route's JSON Schema has already checked types. Null when valid. */
export function validateStructure(chapters: DraftChapter[], pageCount: number): string | null {
  if (chapters.length === 0) return "Add at least one chapter before committing.";

  const numbers = new Set<number>();
  for (const c of chapters) {
    const label = `Chapter ${c.number}`;
    if (!Number.isInteger(c.number) || c.number < 1) return `Chapter numbers must be whole numbers from 1 (got ${c.number}).`;
    if (numbers.has(c.number)) return `${label} appears more than once.`;
    numbers.add(c.number);
    if (!c.title.trim()) return `${label} needs a title.`;
    if (c.startPage < 1 || c.endPage > pageCount || c.startPage > c.endPage) {
      return `${label}'s pages must run forwards within 1–${pageCount} (got ${c.startPage}–${c.endPage}).`;
    }

    const codes = new Set<string>();
    for (const t of c.topics) {
      if (!t.code.trim() || !t.title.trim()) return `Every topic in ${label} needs a number and a title.`;
      if (codes.has(t.code)) return `Topic ${t.code} appears more than once in ${label}.`;
      codes.add(t.code);
      if (t.startPage > t.endPage || t.startPage < c.startPage || t.endPage > c.endPage) {
        return `Topic ${t.code}'s pages (${t.startPage}–${t.endPage}) must fall inside ${label}'s (${c.startPage}–${c.endPage}).`;
      }
    }
  }

  const byStart = [...chapters].sort((a, b) => a.startPage - b.startPage);
  for (let i = 1; i < byStart.length; i++) {
    const prev = byStart[i - 1]!;
    const cur = byStart[i]!;
    if (cur.startPage <= prev.endPage) {
      return `Chapters ${prev.number} (${prev.startPage}–${prev.endPage}) and ${cur.number} (${cur.startPage}–${cur.endPage}) overlap.`;
    }
  }
  return null;
}

/** The topic code a transcribed heading line carries, or null. */
export function headingCodeOf(line: string): string | null {
  return HEADING_LINE.exec(line)?.[1] ?? null;
}

/**
 * Splits a chapter's page text into per-topic segments, in reading order.
 * The transcribed heading line is the primary signal; a topic whose heading
 * the text didn't mark switches at the top of its recorded start page
 * instead, so an admin-edited topic is never silently dropped. Text before
 * the first topic (the chapter's introduction) has no topic.
 */
export function buildChapterSegments(chapter: DraftChapter, pages: PageWithText[]): ContentSegment[] {
  const codes = new Set(chapter.topics.map((t) => t.code));
  const startsByPage = new Map<number, string[]>();
  for (const t of chapter.topics) startsByPage.set(t.startPage, [...(startsByPage.get(t.startPage) ?? []), t.code]);

  const inRange = pages
    .filter((p) => p.pageNumber >= chapter.startPage && p.pageNumber <= chapter.endPage && !SKIPPED_KINDS.has(p.pageKind))
    .sort((a, b) => a.pageNumber - b.pageNumber);

  const segments: ContentSegment[] = [];
  const activated = new Set<string>();
  let current: string | null = null;

  for (const page of inRange) {
    const lines = page.text.split("\n");
    const marked = new Set(lines.map(headingCodeOf).filter((c): c is string => c !== null && codes.has(c)));
    for (const code of startsByPage.get(page.pageNumber) ?? []) {
      if (!marked.has(code) && !activated.has(code)) {
        current = code;
        activated.add(code);
      }
    }

    let buffer: string[] = [];
    const flush = (): void => {
      const text = buffer.join("\n").trim();
      if (text) segments.push({ topicCode: current, page: page.pageNumber, text });
      buffer = [];
    };
    for (const line of lines) {
      const code = headingCodeOf(line);
      if (code !== null && codes.has(code)) {
        flush();
        current = code;
        activated.add(code);
      }
      buffer.push(line);
    }
    flush();
  }
  return segments;
}
