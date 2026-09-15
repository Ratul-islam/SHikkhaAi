"use client";

import { useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { DraftChapter, DraftTopic } from "../../lib/types";

const INPUT =
  "h-8 rounded-lg border border-outline-variant bg-surface-container-lowest px-2 text-sm text-on-surface placeholder:text-on-surface-variant/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:bg-surface-container-low disabled:text-on-surface-variant";

function toInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function PageRange({
  start,
  end,
  pageCount,
  disabled,
  label,
  onChange,
}: {
  start: number;
  end: number;
  pageCount: number;
  disabled?: boolean;
  label: string;
  onChange: (range: { startPage: number; endPage: number }) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={1}
        max={pageCount}
        value={start}
        disabled={disabled}
        aria-label={`${label} first page`}
        onChange={(e) => onChange({ startPage: toInt(e.target.value, start), endPage: end })}
        className={cn(INPUT, "w-[4.5rem] tabular-nums")}
      />
      <span className="text-on-surface-variant">–</span>
      <input
        type="number"
        min={1}
        max={pageCount}
        value={end}
        disabled={disabled}
        aria-label={`${label} last page`}
        onChange={(e) => onChange({ startPage: start, endPage: toInt(e.target.value, end) })}
        className={cn(INPUT, "w-[4.5rem] tabular-nums")}
      />
    </div>
  );
}

/** Editable chapters with nested topics — the review step before a book is published. */
export default function StructureEditor({
  chapters,
  onChange,
  pageCount,
  disabled,
}: {
  chapters: DraftChapter[];
  onChange: (chapters: DraftChapter[]) => void;
  pageCount: number;
  disabled?: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  function patchChapter(index: number, patch: Partial<DraftChapter>): void {
    onChange(chapters.map((c, i) => (i === index ? { ...c, ...patch } : c)));
  }

  function patchTopic(chapterIndex: number, topicIndex: number, patch: Partial<DraftTopic>): void {
    const chapter = chapters[chapterIndex]!;
    patchChapter(chapterIndex, { topics: chapter.topics.map((t, i) => (i === topicIndex ? { ...t, ...patch } : t)) });
  }

  function toggle(index: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function addChapter(): void {
    const last = chapters[chapters.length - 1];
    const number = Math.max(0, ...chapters.map((c) => c.number)) + 1;
    const startPage = Math.min(pageCount, (last?.endPage ?? 0) + 1);
    onChange([...chapters, { number, title: "", startPage, endPage: pageCount, topics: [] }]);
  }

  function removeChapter(index: number): void {
    onChange(chapters.filter((_, i) => i !== index));
    setExpanded(new Set());
  }

  function addTopic(index: number): void {
    const c = chapters[index]!;
    patchChapter(index, {
      topics: [...c.topics, { code: `${c.number}.${c.topics.length + 1}`, title: "", startPage: c.startPage, endPage: c.endPage }],
    });
    setExpanded((prev) => new Set(prev).add(index));
  }

  return (
    <div>
      {chapters.length > 0 && (
        <ol className="divide-y divide-outline-variant/50 overflow-hidden rounded-xl border border-outline-variant/70">
          {chapters.map((chapter, ci) => {
            const open = expanded.has(ci);
            const label = `Chapter ${chapter.number}`;
            return (
              <li key={ci}>
                <div className="flex flex-wrap items-center gap-2 px-2 py-2">
                  <button
                    type="button"
                    onClick={() => toggle(ci)}
                    aria-expanded={open}
                    aria-label={`${open ? "Hide" : "Show"} topics in ${label}`}
                    className="flex size-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                  >
                    <ChevronRight className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-90")} />
                  </button>
                  <input
                    type="number"
                    min={1}
                    value={chapter.number}
                    disabled={disabled}
                    aria-label={`${label} number`}
                    onChange={(e) => patchChapter(ci, { number: toInt(e.target.value, chapter.number) })}
                    className={cn(INPUT, "w-14 tabular-nums")}
                  />
                  <input
                    value={chapter.title}
                    disabled={disabled}
                    placeholder="Chapter title"
                    aria-label={`${label} title`}
                    onChange={(e) => patchChapter(ci, { title: e.target.value })}
                    className={cn(INPUT, "min-w-[12rem] flex-1 font-medium")}
                  />
                  <PageRange
                    start={chapter.startPage}
                    end={chapter.endPage}
                    pageCount={pageCount}
                    disabled={disabled}
                    label={label}
                    onChange={(range) => patchChapter(ci, range)}
                  />
                  <button
                    type="button"
                    onClick={() => toggle(ci)}
                    className="w-20 text-left text-sm tabular-nums text-on-surface-variant hover:text-primary"
                  >
                    {chapter.topics.length} {chapter.topics.length === 1 ? "topic" : "topics"}
                  </button>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={() => removeChapter(ci)}
                      aria-label={`Remove ${label}`}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant hover:bg-error-container/60 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>

                {open && (
                  <div className="border-t border-outline-variant/40 bg-surface-container-low/60 py-2 pl-12 pr-2">
                    {chapter.topics.length === 0 && (
                      <p className="px-1 py-1.5 text-sm text-on-surface-variant">No topics. Students can still ask about the whole chapter.</p>
                    )}
                    <ul className="flex flex-col gap-1.5">
                      {chapter.topics.map((topic, ti) => (
                        <li key={ti} className="flex flex-wrap items-center gap-2">
                          <input
                            value={topic.code}
                            disabled={disabled}
                            aria-label={`${label} topic ${ti + 1} number`}
                            onChange={(e) => patchTopic(ci, ti, { code: e.target.value })}
                            className={cn(INPUT, "w-16 tabular-nums")}
                          />
                          <input
                            value={topic.title}
                            disabled={disabled}
                            placeholder="Topic title"
                            aria-label={`${label} topic ${ti + 1} title`}
                            onChange={(e) => patchTopic(ci, ti, { title: e.target.value })}
                            className={cn(INPUT, "min-w-[12rem] flex-1")}
                          />
                          <PageRange
                            start={topic.startPage}
                            end={topic.endPage}
                            pageCount={pageCount}
                            disabled={disabled}
                            label={`Topic ${topic.code}`}
                            onChange={(range) => patchTopic(ci, ti, range)}
                          />
                          {!disabled && (
                            <button
                              type="button"
                              onClick={() => patchChapter(ci, { topics: chapter.topics.filter((_, i) => i !== ti) })}
                              aria-label={`Remove topic ${topic.code}`}
                              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-on-surface-variant hover:bg-error-container/60 hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              <Trash2 className="size-4" />
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                    {!disabled && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => addTopic(ci)} className="mt-1.5">
                        <Plus />
                        Add topic
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {!disabled && (
        <Button type="button" variant="outline" size="sm" onClick={addChapter} className="mt-3">
          <Plus />
          Add chapter
        </Button>
      )}
    </div>
  );
}
