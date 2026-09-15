"use client";

import { useMemo } from "react";
import { BookOpenText, ChevronDown, ListTree } from "lucide-react";
import { GENERAL_CHAPTER, GENERAL_SUBJECT, isGeneralConversation } from "../../lib/chat";
import type { ChatChapterOption } from "../../lib/types";

export interface ChatTopicTarget {
  subject: string;
  chapter: number;
  topicId: string | null;
}

export interface ChatTopicPickerProps {
  subject: string;
  chapter: number;
  topicId: string | null;
  /** From GET /chat/topics, fetched once by the page (which also titles its header from it). */
  chapters: ChatChapterOption[];
  onChange: (target: ChatTopicTarget) => void;
}

const SELECT_CLASS =
  "max-w-[11rem] cursor-pointer appearance-none truncate rounded-full border border-outline-variant/30 bg-surface-container-lowest/60 backdrop-blur-md py-2 pl-9 pr-8 text-[13px] font-label-md text-on-surface shadow-[0_2px_8px_rgba(0,0,0,0.04)] transition-all hover:border-primary/40 hover:bg-surface-container-lowest hover:shadow-[0_4px_12px_rgba(0,104,95,0.08)] hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-primary/40 sm:max-w-[18rem]";

/**
 * Chapter first, then topic — shown inside the empty-state composer, a
 * ChatGPT-style front door (matches design_files/Image 2.png's composer
 * mockup, which already has a subject chip inside the input bar).
 *
 * Picking a chapter clears the topic ("পুরো অধ্যায়" — the whole chapter);
 * the topic chip only appears once a chapter with detected topics is chosen.
 *
 * Selecting a target only retargets the DRAFT (chat/page.tsx's `switchTopic`
 * drops the slot) — it never reopens an existing thread for that chapter. The
 * draft claims the next free slot when its first message is sent; existing
 * threads are reopened from ChatSidebar's list.
 */
export default function ChatTopicPicker({ subject, chapter, topicId, chapters, onChange }: ChatTopicPickerProps): JSX.Element {
  // Server already sorts subject → chapter, so first appearance is display order.
  const subjectsInOrder = useMemo(() => Array.from(new Set(chapters.map((c) => c.subject))), [chapters]);
  const general = isGeneralConversation(subject);
  const active = general ? undefined : chapters.find((c) => c.subject === subject && c.chapter === chapter);
  const chapterValue = general ? "general" : `${subject}::${chapter}`;

  function handleChapterChange(raw: string): void {
    if (raw === "general") {
      onChange({ subject: GENERAL_SUBJECT, chapter: GENERAL_CHAPTER, topicId: null });
      return;
    }
    const [s, c] = raw.split("::");
    onChange({ subject: s!, chapter: Number(c), topicId: null });
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <div className="relative inline-flex shrink-0 items-center">
        <BookOpenText className="pointer-events-none absolute left-3 size-4 text-primary/70" />
        <select
          value={chapterValue}
          onChange={(e) => handleChapterChange(e.target.value)}
          aria-label="কোন অধ্যায় নিয়ে কথা বলবে বেছে নাও"
          className={SELECT_CLASS}
        >
          <option value="general">সাধারণ আলোচনা</option>
          {subjectsInOrder.map((s) => (
            <optgroup key={s} label={s}>
              {chapters
                .filter((c) => c.subject === s)
                .map((c) => (
                  <option key={`${c.subject}::${c.chapter}`} value={`${c.subject}::${c.chapter}`}>
                    অধ্যায় {c.chapter}
                    {c.title ? ` — ${c.title}` : ""}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2.5 size-4 text-on-surface-variant/60" />
      </div>

      {active && active.topics.length > 0 && (
        <div className="relative inline-flex shrink-0 items-center">
          <ListTree className="pointer-events-none absolute left-3 size-4 text-primary/70" />
          <select
            value={topicId ?? ""}
            onChange={(e) => onChange({ subject, chapter, topicId: e.target.value || null })}
            aria-label="অধ্যায়ের কোন টপিক, বেছে নাও"
            className={SELECT_CLASS}
          >
            <option value="">পুরো অধ্যায়</option>
            {active.topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.code} {t.title}
              </option>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-2.5 size-4 text-on-surface-variant/60" />
        </div>
      )}
    </div>
  );
}
