"use client";

import { useMemo, useState, type FormEvent } from "react";
import { cn } from "@/lib/utils";
import type { DraftChapter } from "../../lib/types";

/**
 * Every page of the book as one small cell, banded by chapter. While the book
 * is being read, cells fill in as pages come back; during review, the bands
 * follow the chapter ranges being edited, so a wrong boundary is visible at a
 * glance. Clicking a cell opens that page.
 */

const KINDS: Record<string, { className: string; label: string }> = {
  content: { className: "bg-primary/45", label: "Read" },
  chapter_opening: { className: "bg-primary", label: "Chapter opening" },
  exercises: { className: "bg-secondary-container", label: "Exercises" },
  front_matter: { className: "bg-outline-variant", label: "Front matter" },
  blank: { className: "bg-outline-variant/60", label: "Blank" },
  failed: { className: "bg-error", label: "Couldn't read" },
};
const WAITING = { className: "bg-surface-container-high", label: "Waiting to be read" };
const LEGEND = [
  WAITING,
  KINDS.content!,
  KINDS.chapter_opening!,
  KINDS.exercises!,
  KINDS.front_matter!,
  KINDS.failed!,
];

interface Band {
  key: string;
  label: string;
  title: string | null;
  start: number;
  end: number;
}

function buildBands(pageCount: number, chapters: DraftChapter[]): Band[] {
  const sorted = chapters
    .filter((c) => c.startPage >= 1 && c.endPage >= c.startPage)
    .sort((a, b) => a.startPage - b.startPage);
  const bands: Band[] = [];
  let cursor = 1;
  for (const c of sorted) {
    const start = Math.max(c.startPage, cursor);
    const end = Math.min(c.endPage, pageCount);
    // Overlapping or out-of-range chapters are left out of the map; the editor's publish check names them.
    if (start > end) continue;
    if (start > cursor) {
      bands.push({ key: `gap-${cursor}`, label: cursor === 1 ? "Front matter" : "Not in a chapter", title: null, start: cursor, end: start - 1 });
    }
    bands.push({ key: `ch-${c.number}-${start}`, label: `Chapter ${c.number}`, title: c.title || null, start, end });
    cursor = end + 1;
  }
  if (cursor <= pageCount) {
    bands.push({
      key: `gap-${cursor}`,
      label: sorted.length === 0 ? "All pages" : "After the last chapter",
      title: null,
      start: cursor,
      end: pageCount,
    });
  }
  return bands;
}

export default function PageMap({
  pageCount,
  pageKinds,
  chapters,
  selectedPage,
  onOpenPage,
}: {
  pageCount: number;
  pageKinds: (string | null)[];
  chapters: DraftChapter[];
  selectedPage: number | null;
  onOpenPage: (page: number) => void;
}): JSX.Element {
  const bands = useMemo(() => buildBands(pageCount, chapters), [pageCount, chapters]);
  const [jumpTo, setJumpTo] = useState("");

  function handleJump(e: FormEvent): void {
    e.preventDefault();
    const page = Number.parseInt(jumpTo, 10);
    if (page >= 1 && page <= pageCount) onOpenPage(page);
  }

  return (
    <div>
      <div>
        {bands.map((band) => (
          <div
            key={band.key}
            className="grid gap-x-6 gap-y-1.5 border-t border-outline-variant/40 py-3 first:border-t-0 first:pt-0 sm:grid-cols-[12rem_1fr]"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-on-surface">{band.label}</p>
              {band.title && <p className="truncate text-sm text-on-surface-variant">{band.title}</p>}
              <p className="text-xs tabular-nums text-on-surface-variant/80">
                Pages {band.start}–{band.end}
              </p>
            </div>
            <div className="flex flex-wrap content-start gap-[3px]">
              {Array.from({ length: band.end - band.start + 1 }, (_, i) => {
                const page = band.start + i;
                const kind = pageKinds[page - 1];
                const style = kind ? (KINDS[kind] ?? KINDS.content!) : WAITING;
                return (
                  <button
                    key={page}
                    type="button"
                    tabIndex={-1}
                    onClick={() => onOpenPage(page)}
                    title={`Page ${page}: ${style.label}`}
                    aria-label={`Open page ${page} (${style.label})`}
                    className={cn(
                      "size-3 rounded-[3px] transition-transform motion-safe:hover:scale-125",
                      style.className,
                      selectedPage === page && "ring-2 ring-on-surface ring-offset-1 ring-offset-surface-container-lowest",
                    )}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant/40 pt-4">
        <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-on-surface-variant">
          {LEGEND.map((item) => (
            <li key={item.label} className="flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-[3px]", item.className)} />
              {item.label}
            </li>
          ))}
        </ul>
        <form onSubmit={handleJump} className="flex items-center gap-2">
          <label htmlFor="page-jump" className="text-xs text-on-surface-variant">
            Open page
          </label>
          <input
            id="page-jump"
            type="number"
            min={1}
            max={pageCount}
            value={jumpTo}
            onChange={(e) => setJumpTo(e.target.value)}
            className="h-8 w-20 rounded-lg border border-outline-variant bg-surface-container-lowest px-2 text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          <button
            type="submit"
            className="h-8 rounded-lg border border-outline-variant px-3 text-sm font-medium text-on-surface hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Open
          </button>
        </form>
      </div>
    </div>
  );
}
