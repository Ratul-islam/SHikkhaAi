/**
 * The page reader's contract: what one textbook page reading looks like, the
 * prompt and JSON Schema that ask for it, and the validator that accepts it.
 *
 * Pure — no env, no client — so structure detection and its tests depend on
 * this rather than on page-reader.service.ts, which does the I/O.
 */

export const PAGE_KINDS = ["chapter_opening", "content", "exercises", "front_matter", "blank"] as const;
export type PageKind = (typeof PAGE_KINDS)[number];

export interface PageHeading {
  /** "1.3", "1.3.1", or "" for an unnumbered heading. */
  code: string;
  title: string;
}

export interface PageReading {
  pageKind: PageKind;
  chapterNumber: number | null;
  chapterTitle: string | null;
  runningHeader: string;
  printedPageNumber: number | null;
  headings: PageHeading[];
  text: string;
}

export const PAGE_READING_PROMPT = `You are reading one page of a Bangladeshi NCTB textbook. Return JSON only.
- pageKind: "chapter_opening" if this page begins a new chapter (e.g. "Chapter Two / Motion"), "exercises" for end-of-chapter question sets, "front_matter" for cover, preface or contents pages, "blank" for a page with no text, otherwise "content".
- chapterNumber / chapterTitle: ONLY for a chapter_opening page — the number as an integer (Chapter Two → 2) and the chapter's title. Otherwise 0 and "".
- runningHeader: the small header line at the very top of the page (often the chapter title or the book's name), or "".
- printedPageNumber: the page number printed on the page, or 0.
- headings: every numbered or bold section heading that STARTS on this page, in order. code is its number ("1.3", "1.3.1") or "" if unnumbered; title is the heading without its number.
- text: all body text in reading order as Markdown. Write every heading as a Markdown heading that keeps its number ("### 1.3 Development of physics"). Write equations in LaTeX ($...$). Write a figure as "[Figure 1.01: caption]". Leave out the running header and the page number. Transcribe — do not summarize.`;

export const PAGE_READING_JSON_SCHEMA = {
  type: "object",
  properties: {
    pageKind: { type: "string", enum: [...PAGE_KINDS] },
    chapterNumber: { type: "integer" },
    chapterTitle: { type: "string" },
    runningHeader: { type: "string" },
    printedPageNumber: { type: "integer" },
    headings: {
      type: "array",
      items: {
        type: "object",
        properties: { code: { type: "string" }, title: { type: "string" } },
        required: ["code", "title"],
      },
    },
    text: { type: "string" },
  },
  required: ["pageKind", "chapterNumber", "chapterTitle", "runningHeader", "printedPageNumber", "headings", "text"],
};

function isPageKind(value: unknown): value is PageKind {
  return typeof value === "string" && (PAGE_KINDS as readonly string[]).includes(value);
}

/** Validates the model's JSON into a PageReading; null when the shape is unusable. */
export function parsePageReading(raw: unknown): PageReading | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isPageKind(r.pageKind) || typeof r.text !== "string") return null;

  const chapterNumber =
    r.pageKind === "chapter_opening" && typeof r.chapterNumber === "number" && Number.isInteger(r.chapterNumber) && r.chapterNumber > 0
      ? r.chapterNumber
      : null;
  const chapterTitle =
    chapterNumber !== null && typeof r.chapterTitle === "string" && r.chapterTitle.trim() ? r.chapterTitle.trim() : null;

  const headings: PageHeading[] = Array.isArray(r.headings)
    ? r.headings.flatMap((h): PageHeading[] => {
        if (!h || typeof h !== "object") return [];
        const { code, title } = h as Record<string, unknown>;
        if (typeof title !== "string" || !title.trim()) return [];
        return [
          {
            code: typeof code === "string" ? code.trim().replace(/\.$/, "") : "",
            title: title.trim().replace(/[:：]\s*$/, "").trim(),
          },
        ];
      })
    : [];

  return {
    // An "opening" with no usable number can't bound a chapter, so it's just content.
    pageKind: r.pageKind === "chapter_opening" && chapterNumber === null ? "content" : r.pageKind,
    chapterNumber,
    chapterTitle,
    runningHeader: typeof r.runningHeader === "string" ? r.runningHeader.trim() : "",
    printedPageNumber:
      typeof r.printedPageNumber === "number" && Number.isInteger(r.printedPageNumber) && r.printedPageNumber > 0
        ? r.printedPageNumber
        : null,
    headings,
    text: r.text.trim(),
  };
}
