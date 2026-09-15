import { describe, expect, it } from "vitest";
import {
  buildChapterSegments,
  detectStructure,
  formatPages,
  headingCodeOf,
  titlesAgree,
  validateStructure,
  type PageOutline,
  type PageWithText,
} from "./structure.service";
import { parsePageReading } from "./page-reading";
import type { DraftChapter } from "./ingestion.schema";

function page(pageNumber: number, overrides: Partial<PageWithText> = {}): PageWithText {
  return {
    pageNumber,
    pageKind: "content",
    chapterNumber: null,
    chapterTitle: null,
    runningHeader: "",
    headings: [],
    text: "",
    ...overrides,
  };
}

function opening(pageNumber: number, chapterNumber: number, chapterTitle: string): PageOutline {
  return page(pageNumber, { pageKind: "chapter_opening", chapterNumber, chapterTitle });
}

describe("detectStructure", () => {
  it("bounds chapters by their opening pages and excludes front matter before chapter one", () => {
    const pages = [
      page(1, { pageKind: "front_matter" }),
      opening(2, 1, "Physical Quantities"),
      page(3, { headings: [{ code: "1.1", title: "Physics" }] }),
      page(4, { headings: [{ code: "1.2", title: "Scope" }, { code: "1.2.1", title: "Sub" }] }),
      opening(5, 2, "Motion"),
      page(6, { headings: [{ code: "2.1", title: "Rest and motion" }] }),
    ];
    const { chapters, warnings } = detectStructure(pages);
    expect(warnings).toEqual([]);
    expect(chapters.map((c) => [c.number, c.title, c.startPage, c.endPage])).toEqual([
      [1, "Physical Quantities", 2, 4],
      [2, "Motion", 5, 6],
    ]);
    // 1.2.1 stays inside 1.2; a topic ends on the page the next one starts.
    expect(chapters[0]!.topics).toEqual([
      { code: "1.1", title: "Physics", startPage: 3, endPage: 4 },
      { code: "1.2", title: "Scope", startPage: 4, endPage: 4 },
    ]);
  });

  it("infers a chapter whose opening was missed from its first numbered section, titled by running header, and warns", () => {
    const pages = [
      opening(1, 1, "Measurements"),
      page(2, { headings: [{ code: "1.1", title: "Physics" }] }),
      page(3, { runningHeader: "Motion", headings: [{ code: "2.1", title: "Rest" }] }),
      page(4, { runningHeader: "Motion" }),
    ];
    const { chapters, warnings } = detectStructure(pages);
    expect(chapters.map((c) => [c.number, c.title, c.startPage, c.endPage])).toEqual([
      [1, "Measurements", 1, 2],
      [2, "Motion", 3, 4],
    ]);
    expect(warnings.some((w) => w.includes("No opening page was found for chapter 2"))).toBe(true);
  });

  it("flags a chapter whose pages mostly carry another title, ignoring the book-wide header", () => {
    const pages = [
      opening(1, 1, "Measurements"),
      page(2, { runningHeader: "Physics" }),
      page(3, { runningHeader: "Motion" }),
      page(4, { runningHeader: "Physics" }),
      page(5, { runningHeader: "Motion" }),
      opening(6, 2, "Motion"),
      page(7, { runningHeader: "Physics" }),
      page(8, { runningHeader: "Physics" }),
      opening(9, 3, "Force"),
      page(10, { runningHeader: "Physics" }),
      page(11, { runningHeader: "Force" }),
      page(12, { runningHeader: "Force" }),
    ];
    const { warnings } = detectStructure(pages);
    expect(warnings).toEqual([
      'Chapter 1 "Measurements": most of its pages are headed "Motion". Check its title and page range.',
    ]);
  });

  it("reports failed pages and missing chapter numbers", () => {
    const pages = [opening(1, 1, "A"), page(2, { pageKind: "failed" }), page(3, { pageKind: "failed" }), opening(4, 3, "C")];
    const { warnings } = detectStructure(pages);
    expect(warnings[0]).toContain("2 page(s) couldn't be read (2–3)");
    expect(warnings).toContain("Chapter(s) 2 weren't found.");
  });

  it("treats openings a few pages apart as one multi-page opening, without warning", () => {
    const { chapters, warnings } = detectStructure([opening(1, 1, "A"), page(2), opening(3, 1, "A"), page(4)]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.startPage).toBe(1);
    expect(warnings).toEqual([]);
  });

  it("ignores zero-padded investigation/figure codes and strips trailing colons from titles", () => {
    const { chapters } = detectStructure([
      opening(1, 1, "Measurements:"),
      page(2, { headings: [{ code: "1.1", title: "Physics:" }, { code: "1.01", title: "Investigation" }] }),
      page(3, { headings: [{ code: "2.03", title: "Investigation" }] }),
    ]);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]!.title).toBe("Measurements");
    expect(chapters[0]!.topics.map((t) => [t.code, t.title])).toEqual([["1.1", "Physics"]]);
  });

  it("accepts a running header that abbreviates the chapter title", () => {
    const { warnings } = detectStructure([
      opening(1, 1, "Work, Power and Energy"),
      page(2, { runningHeader: "Work, Power, Energy" }),
      page(3, { runningHeader: "Work, Power, Energy" }),
      opening(4, 2, "Effects of Heat on Matter"),
      page(5, { runningHeader: "Effect of Heat on Matter" }),
      page(6, { runningHeader: "Effect of Heat on Matter" }),
    ]);
    expect(warnings).toEqual([]);
  });
});

describe("titlesAgree", () => {
  it("compares words, ignoring stop words and plurals", () => {
    expect(titlesAgree("Work, Power, Energy", "Work, Power and Energy")).toBe(true);
    expect(titlesAgree("Effect of Heat on Matter", "Effects of Heat on Matter")).toBe(true);
    expect(titlesAgree("Motion", "Physical Quantities and Their Measurements")).toBe(false);
  });
});

describe("validateStructure", () => {
  const base: DraftChapter[] = [
    { number: 1, title: "A", startPage: 1, endPage: 10, topics: [{ code: "1.1", title: "x", startPage: 2, endPage: 5 }] },
    { number: 2, title: "B", startPage: 11, endPage: 20, topics: [] },
  ];

  it("accepts a contiguous, non-overlapping structure", () => {
    expect(validateStructure(base, 20)).toBeNull();
  });

  it("rejects overlaps, duplicates, out-of-range pages and stray topics", () => {
    expect(validateStructure([base[0]!, { ...base[1]!, startPage: 10 }], 20)).toContain("overlap");
    expect(validateStructure([base[0]!, { ...base[1]!, number: 1 }], 20)).toContain("more than once");
    expect(validateStructure(base, 15)).toContain("within 1–15");
    expect(
      validateStructure([{ ...base[0]!, topics: [{ code: "1.1", title: "x", startPage: 9, endPage: 12 }] }, base[1]!], 20),
    ).toContain("must fall inside");
    expect(validateStructure([], 20)).toContain("at least one chapter");
  });
});

describe("buildChapterSegments", () => {
  const chapter: DraftChapter = {
    number: 1,
    title: "A",
    startPage: 1,
    endPage: 3,
    topics: [
      { code: "1.1", title: "Physics", startPage: 1, endPage: 2 },
      { code: "1.2", title: "Scope", startPage: 2, endPage: 3 },
      { code: "1.3", title: "History", startPage: 3, endPage: 3 },
    ],
  };

  it("splits on heading lines, keeps sub-sections in their topic, and switches at page top for an unmarked topic", () => {
    const pages: PageWithText[] = [
      page(1, { text: "Intro text.\n### 1.1 Physics\nPhysics body." }),
      page(2, { text: "More physics.\n### 1.2 Scope\nScope body.\n### 1.2.1 Detail\nDetail body. Speed is 1.5 m/s." }),
      // 1.3's heading wasn't transcribed as a heading — it starts here per the structure.
      page(3, { text: "History body." }),
      page(4, { text: "Outside the chapter." }),
    ];
    expect(buildChapterSegments(chapter, pages)).toEqual([
      { topicCode: null, page: 1, text: "Intro text." },
      { topicCode: "1.1", page: 1, text: "### 1.1 Physics\nPhysics body." },
      { topicCode: "1.1", page: 2, text: "More physics." },
      { topicCode: "1.2", page: 2, text: "### 1.2 Scope\nScope body.\n### 1.2.1 Detail\nDetail body. Speed is 1.5 m/s." },
      { topicCode: "1.3", page: 3, text: "History body." },
    ]);
  });

  it("skips unreadable and front-matter pages", () => {
    const pages = [page(1, { pageKind: "failed", text: "x" }), page(2, { pageKind: "front_matter", text: "y" })];
    expect(buildChapterSegments({ ...chapter, topics: [] }, pages)).toEqual([]);
  });
});

describe("headingCodeOf", () => {
  it("requires a heading or bold marker and a two-level code", () => {
    expect(headingCodeOf("### 1.3 Development")).toBe("1.3");
    expect(headingCodeOf("**2.10 Friction**")).toBe("2.10");
    expect(headingCodeOf("### 1.3.1 Initial stage")).toBeNull();
    expect(headingCodeOf("1.5 m/s is the speed")).toBeNull();
  });
});

describe("formatPages", () => {
  it("collapses runs", () => {
    expect(formatPages([9, 3, 7, 8])).toBe("3, 7–9");
  });
});

describe("parsePageReading", () => {
  it("normalizes a chapter opening and heading codes", () => {
    expect(
      parsePageReading({
        pageKind: "chapter_opening",
        chapterNumber: 2,
        chapterTitle: " Motion ",
        runningHeader: "",
        printedPageNumber: 0,
        headings: [{ code: "2.1.", title: "Rest" }, { code: "", title: "" }],
        text: " body ",
      }),
    ).toEqual({
      pageKind: "chapter_opening",
      chapterNumber: 2,
      chapterTitle: "Motion",
      runningHeader: "",
      printedPageNumber: null,
      headings: [{ code: "2.1", title: "Rest" }],
      text: "body",
    });
  });

  it("demotes an opening without a chapter number, and rejects unusable shapes", () => {
    expect(parsePageReading({ pageKind: "chapter_opening", chapterNumber: 0, text: "" })?.pageKind).toBe("content");
    expect(parsePageReading({ pageKind: "poster", text: "" })).toBeNull();
    expect(parsePageReading("nope")).toBeNull();
  });
});
