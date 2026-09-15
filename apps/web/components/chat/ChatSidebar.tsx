"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { MessageSquareText, Map, Plus, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { GENERAL_CHAPTER, GENERAL_SUBJECT, conversationHref, isGeneralConversation } from "../../lib/chat";
import type { ConversationSummary } from "../../lib/types";

/** "৫ মিনিট আগে" / "৩ ঘণ্টা আগে" / "গতকাল" / a short date — no new dependency, this app has no date-fns. */
function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMs = Date.now() - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "এইমাত্র";
  if (diffMin < 60) return `${diffMin} মিনিট আগে`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ঘণ্টা আগে`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return "গতকাল";
  if (diffDay < 7) return `${diffDay} দিন আগে`;
  return new Date(iso).toLocaleDateString("bn-BD", { month: "short", day: "numeric" });
}

export interface ChatSidebarProps {
  conversations: ConversationSummary[];
  loading: boolean;
  activeSubject: string;
  activeChapter: number;
  /** Null while the page is a draft (a new conversation not yet sent) — no thread in the list is active then. */
  activeConversationSlot: number | null;
  /** Called after navigating to another conversation — lets the Sheet wrapper (mobile) close itself. */
  onNavigate?: () => void;
  /** "নতুন কথোপকথন" — owned by the page, since only it can reset the thread and focus the composer. */
  onNewConversation: () => void;
}

/**
 * ChatGPT-shaped: "নতুন কথোপকথন" goes to bare /chat — the start page, where
 * the composer's topic picker chooses General or a chapter (class stays the
 * student's own profile grade, never picked here). That page is a DRAFT: it
 * only becomes a thread, in the next free slot, once a message is sent (see
 * chat/page.tsx), so a student can start as many conversations per chapter as
 * they like. Existing threads reopen from the list below.
 */
export default function ChatSidebar({
  conversations,
  loading,
  activeSubject,
  activeChapter,
  activeConversationSlot,
  onNavigate,
  onNewConversation,
}: ChatSidebarProps): JSX.Element {
  const router = useRouter();
  const generalDraftActive = isGeneralConversation(activeSubject) && activeConversationSlot === null;

  function openConversation(c: ConversationSummary): void {
    router.push(conversationHref(c));
    onNavigate?.();
  }

  // A blank General draft — reopening an existing General thread is still
  // just a click away in the list below.
  function openGeneral(): void {
    router.push(`/chat?subject=${encodeURIComponent(GENERAL_SUBJECT)}&chapter=${GENERAL_CHAPTER}`);
    onNavigate?.();
  }

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="flex flex-col gap-3 p-4">
        <button
          type="button"
          onClick={onNewConversation}
          className="flex items-center gap-2 rounded-2xl bg-gradient-to-r from-primary to-tertiary px-4 py-3.5 text-[15px] font-label-lg text-on-primary shadow-[0_4px_16px_rgba(0,104,95,0.25)] transition-all hover:shadow-[0_6px_20px_rgba(0,104,95,0.35)] hover:-translate-y-0.5 active:scale-95"
        >
          <Plus className="size-5" />
          নতুন কথোপকথন
        </button>
        <Link
          href="/roadmap"
          onClick={onNavigate}
          className="flex items-center gap-2 rounded-2xl border border-outline-variant/30 bg-surface-container-lowest/50 backdrop-blur-sm px-4 py-3 text-sm font-label-md text-on-surface-variant shadow-sm transition-all hover:border-primary/40 hover:bg-surface-container-lowest/80 hover:text-primary hover:-translate-y-0.5"
        >
          <Map className="size-[18px]" />
          রোডম্যাপ দেখুন
        </Link>

        {/* Pinned quick-access */}
        <button
          type="button"
          onClick={openGeneral}
          className={cn(
            "flex items-center gap-2 rounded-2xl px-4 py-2.5 text-sm font-label-md transition-all border",
            generalDraftActive
              ? "bg-primary/10 border-primary/20 text-primary shadow-sm"
              : "border-transparent text-on-surface-variant hover:bg-surface-container-lowest/50 hover:border-outline-variant/20 hover:text-on-surface",
          )}
        >
          <Sparkles className="size-[18px]" />
          সাধারণ আলোচনা
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        <p className="px-2 pb-2 pt-2 text-xs font-label-sm font-semibold uppercase tracking-wider text-on-surface-variant/50">
          কথোপকথনসমূহ
        </p>

        {loading && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-on-surface-variant/60">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        )}

        {!loading && conversations.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center px-4">
            <MessageSquareText className="size-8 text-outline-variant/50 mb-2" />
            <p className="text-sm text-on-surface-variant/70 leading-relaxed">
              এখনো কোনো কথোপকথন নেই — শুরু করতে <span className="font-semibold text-primary">নতুন কথোপকথন</span>-এ ক্লিক করুন।
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5 mt-1">
          {conversations.map((c) => {
            const active =
              c.subject === activeSubject && c.chapter === activeChapter && c.conversationSlot === activeConversationSlot;
            return (
              <button
                key={`${c.subject}::${c.chapter}::${c.conversationSlot}`}
                type="button"
                onClick={() => openConversation(c)}
                className={cn(
                  "flex flex-col gap-1 rounded-2xl px-3.5 py-3 text-left transition-all border",
                  active
                    ? "bg-surface-container-lowest/80 backdrop-blur-md border-primary/20 text-primary shadow-sm"
                    : "border-transparent bg-transparent text-on-surface-variant hover:bg-surface-container-lowest/50 hover:border-outline-variant/20 hover:shadow-sm hover:text-on-surface",
                )}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  <MessageSquareText className={cn("size-4 shrink-0", active ? "text-primary" : "text-on-surface-variant/70")} />
                  <span className="truncate leading-tight">{c.title}</span>
                </span>
                <span className="truncate pl-6 text-xs text-on-surface-variant/60 leading-tight">
                  {c.lastMessagePreview || " "}
                </span>
                <span className="pl-6 text-[10px] uppercase tracking-wider text-on-surface-variant/40 font-semibold mt-0.5">
                  {formatRelativeTime(c.lastMessageAt)}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
