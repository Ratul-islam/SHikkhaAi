"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import rehypeKatex from "rehype-katex";
import { Volume2, Lightbulb, Sparkles, ListChecks, Calculator, GraduationCap, CornerDownRight, Maximize2, PlayCircle } from "lucide-react";
import VisualSandbox, { type WidgetEvent } from "./VisualSandbox";
import type { ResponseType, VideoBrief, VideoScript } from "../lib/types";

export interface ChatMessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** The orchestrator's own decision for this turn (assistant messages only) — feeds buildActionPills so the pills react to what was actually decided. */
  responseType?: ResponseType;
  reasoning?: string;
  /**
   * The turn's interactive widget, rendered inline in this very message.
   * Before this, a visual could only ever appear in the right-hand drawer and
   * only for the *latest* assistant turn — scrolling back lost every earlier
   * diagram. Now the drawer is a bigger view of it, not the only one.
   */
  visualHtml?: string;
  /** Follow-up messages in the student's own voice, from the orchestrator. Falls back to buildActionPills when absent. */
  suggestions?: string[];
  /**
   * The lesson plan for a VIDEO turn, kept on the message so the video can be
   * replayed later — including after a reload. Without this a past video turn
   * had nothing to rebuild from and the panel simply stayed empty.
   *
   * The video is NOT rebuilt automatically on load: that would fire one build
   * per historical video turn at once. It is offered as a button, and since the
   * clip lives in the shared library and narration is cached, replaying is
   * typically free and takes a few seconds.
   */
  videoBrief?: VideoBrief;
  /** LEGACY — a turn stored before the Manim pipeline; replayed from this script. */
  videoScript?: VideoScript;
  /** True while app/chat/page.tsx's typewriter reveal is still filling in `content` — shows a blinking cursor at the end instead of "read aloud"/action pills, which only make sense once the full reply has landed. */
  streaming?: boolean;
}

// Case-insensitive and tolerant of "```svg" / a bare "```" — PROMPT.md tells the
// model to always label the fence "html", but in practice (especially on the
// quota-constrained flash-lite model, see lib/openai.ts) it sometimes labels it
// "svg" or drops the label entirely. All three still open a real fenced block.
const FENCED_HTML_PATTERN = /```(?:html|svg)?\n([\s\S]*?)```/i;

// Fallback for the case actually observed in testing: the model skips the fence
// entirely and emits `<svg>...</svg>` (or `<canvas>...</canvas>`) directly as
// prose. Without this, ReactMarkdown renders the tag as escaped literal text
// instead of stripping it for the visual sandbox — "the diagram shows up as text."
const BARE_VISUAL_TAG_PATTERN = /<(svg|canvas)[\s>][\s\S]*?<\/\1>/i;

export function extractVisualHtml(content: string): { prose: string; html: string | null } {
  const fenced = content.match(FENCED_HTML_PATTERN);
  if (fenced) {
    return { prose: content.replace(FENCED_HTML_PATTERN, "").trim(), html: fenced[1] ?? null };
  }
  const bare = content.match(BARE_VISUAL_TAG_PATTERN);
  if (bare) {
    return { prose: content.replace(BARE_VISUAL_TAG_PATTERN, "").trim(), html: bare[0] };
  }
  return { prose: content, html: null };
}

function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

export interface ActionPill {
  label: string;
  icon: "analogy" | "visual" | "test" | "math";
  prompt: string;
}

const PILL_ICONS = { analogy: Lightbulb, visual: Sparkles, test: ListChecks, math: Calculator };

/** Whatever the orchestrator's own decision output for the turn these pills follow — used to keep the pills decision-aware instead of a fixed static set (PLAN.md Phase 8 §4). */
export interface PillContext {
  responseType?: ResponseType;
  reasoning?: string;
}

const MATH_HEAVY_PATTERN = /\b(equation|formula|proof|derivation|calculat|theorem)\b/i;

export function buildActionPills(lastUserQuestion: string, context: PillContext = {}): ActionPill[] {
  const pills: ActionPill[] = [
    {
      label: "অ্যানালজি দিয়ে বোঝাও",
      icon: "analogy",
      prompt: `"${lastUserQuestion}" — এটা আবার একদম ভিন্ন একটা উপমা দিয়ে বুঝিয়ে দাও তো।`,
    },
  ];

  // Don't offer to generate a visual when this turn already was one — nothing to ask for.
  if (context.responseType !== "CANVAS" && context.responseType !== "VIDEO") {
    pills.push({
      label: "ভিজ্যুয়াল তৈরি করো",
      icon: "visual",
      prompt: `"${lastUserQuestion}" — এটা বুঝতে সাহায্য করার জন্য একটা ভিজ্যুয়াল বা ছোট ভিডিও দেখাও তো।`,
    });
  }

  if (context.reasoning && MATH_HEAVY_PATTERN.test(context.reasoning)) {
    pills.push({
      label: "অঙ্কটা দেখাও",
      icon: "math",
      prompt: `"${lastUserQuestion}" — এর সম্পূর্ণ ধাপে ধাপে অঙ্ক/প্রমাণটা দেখাও তো।`,
    });
  }

  pills.push({
    label: "আমাকে পরীক্ষা করো",
    icon: "test",
    prompt: `"${lastUserQuestion}" নিয়ে আমার বোঝাপড়া যাচাই করতে একটা নতুন প্রশ্ন দাও তো।`,
  });

  return pills;
}

export interface TutorTool {
  label: string;
  prompt: string;
}

/**
 * The always-present ask row under the composer. Deliberately separate from
 * both the generated `suggestions` (which are what the *student* might say
 * next) and `buildActionPills` (the per-message fallback): these are the
 * standing "do this to the last thing you explained" options, so they're
 * available on every turn regardless of what the model returned, and cost
 * nothing — they're plain prompt templates, not a model call.
 *
 * They send a message, never a modality flag. The orchestrator still decides
 * TEXT/CANVAS/VIDEO autonomously every turn (PROMPT.md §4).
 */
export function buildTutorTools(lastQuestion: string): TutorTool[] {
  const about = `"${lastQuestion}"`;
  return [
    { label: "🍵 আরেকটা উপমা", prompt: `${about} — এটা একদম ভিন্ন একটা উপমা দিয়ে আবার বুঝিয়ে দাও তো।` },
    { label: "🪄 সহজ করে বলো", prompt: `${about} — আরও সহজ করে, ছোট করে বলো। ধরে নাও আমি একদম নতুন।` },
    { label: "🔍 আরও গভীরে", prompt: `${about} — এর পেছনের কারণটা আরেকটু গভীরভাবে বুঝিয়ে বলো।` },
    { label: "🧮 অঙ্কটা দেখাও", prompt: `${about} — এর সম্পূর্ণ ধাপে ধাপে অঙ্ক বা প্রমাণটা দেখাও।` },
    { label: "🎨 এঁকে বোঝাও", prompt: `${about} — এটা একটা ইন্টারঅ্যাক্টিভ ছবি দিয়ে বুঝিয়ে দাও, যেটা আমি নেড়েচেড়ে দেখতে পারি।` },
    { label: "🎬 ভিডিও বানাও", prompt: `${about} — এটা নিয়ে একটা ছোট ভিডিও লেসন বানাও তো।` },
    { label: "📝 কুইজ দাও", prompt: `${about} — এটা নিয়ে আমার বোঝাপড়া যাচাই করতে কয়েকটা প্রশ্ন করো।` },
    { label: "🌏 বাস্তব উদাহরণ", prompt: `${about} — এটা বাস্তব জীবনে কোথায় কাজে লাগে, উদাহরণ দিয়ে বলো।` },
  ];
}

export default function ChatMessage({
  message,
  actionPills,
  onPillClick,
  onWidgetEvent,
  onExpandVisual,
  onWatchVideo,
}: {
  message: ChatMessageData;
  actionPills?: ActionPill[];
  onPillClick?: (prompt: string) => void;
  /** A validated `shikkha.result()` / `shikkha.ask()` call from this message's own widget. */
  onWidgetEvent?: (event: WidgetEvent) => void;
  onExpandVisual?: (html: string) => void;
  /** Rebuilds and shows this turn's video on demand — from its brief, or from a stored legacy script. */
  onWatchVideo?: (messageId: string, source: { videoBrief: VideoBrief } | { videoScript: VideoScript }) => void;
}): JSX.Element {
  const { prose, html: legacyHtml } = extractVisualHtml(message.content);
  const isAssistant = message.role === "assistant";
  const [speaking, setSpeaking] = useState(false);

  // The first-class field wins; the regex scrape of `content` remains only as
  // the fallback for turns stored before visualHtml was persisted, and for
  // output that inlines the visual against instructions.
  const visualHtml = message.visualHtml ?? legacyHtml ?? null;
  const suggestions = message.suggestions?.filter((s) => s.trim().length > 0) ?? [];

  // User turns stay a right-aligned pill (ChatGPT and borno.ai both do this).
  // Assistant turns drop the boxed bubble entirely — full-width, borderless
  // prose behind a small persona avatar, the way ChatGPT renders its own
  // replies. The glass-panel treatment is reserved for actual surfaces
  // elsewhere in the app (cards, sheets); a chat reply isn't one.
  if (!isAssistant) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="flex flex-col items-end mb-4"
      >
        <div className="max-w-[80%] md:max-w-[70%] rounded-[24px] rounded-br-[6px] bg-gradient-to-br from-primary to-primary-container px-5 py-3 text-on-primary shadow-md border border-primary/20 backdrop-blur-sm">
          <div className="prose prose-sm md:prose-base max-w-none prose-invert [&_.katex]:text-inherit [&_.katex-display]:border-white/20 [&_.katex-display]:bg-white/10 font-body-md leading-relaxed">
            <ReactMarkdown remarkPlugins={[remarkMath, remarkBreaks]} rehypePlugins={[rehypeKatex]}>
              {prose}
            </ReactMarkdown>
          </div>
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="flex gap-4 mb-6"
    >
      <div className="mt-1 flex size-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary to-tertiary text-on-primary shadow-md">
        <Sparkles className="size-5" />
      </div>

      <div className="min-w-0 flex-1">
        <div className="prose prose-sm md:prose-base max-w-none text-on-surface [&_.katex]:text-inherit font-body-md leading-relaxed">
          <ReactMarkdown remarkPlugins={[remarkMath, remarkBreaks]} rehypePlugins={[rehypeKatex]}>
            {prose}
          </ReactMarkdown>
          {message.streaming && (
            <span className="ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 animate-pulse bg-primary" />
          )}
        </div>

        {/* The widget lives in the message itself, so scrolling back keeps
            every past diagram. The drawer is now a bigger view of this, not
            the only place a visual can exist. */}
        {!message.streaming && visualHtml && (
           <div className="mt-4 rounded-2xl overflow-hidden border border-outline-variant/30 shadow-sm bg-surface-container-lowest">
            <VisualSandbox html={visualHtml} onEvent={onWidgetEvent} />
            {onExpandVisual && (
              <div className="px-4 py-2 border-t border-outline-variant/30 bg-surface-container-low flex justify-end">
                <button
                  type="button"
                  onClick={() => onExpandVisual(visualHtml)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary-container transition-colors"
                >
                  <Maximize2 className="size-3.5" />
                  বড় করে দেখো
                </button>
              </div>
            )}
          </div>
        )}

        {!message.streaming && (message.videoBrief || message.videoScript) && onWatchVideo && (
          <button
            type="button"
            onClick={() =>
              onWatchVideo(
                message.id,
                message.videoBrief
                  ? { videoBrief: message.videoBrief }
                  : { videoScript: message.videoScript! },
              )
            }
            className="mt-3 flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 shadow-sm w-fit"
          >
            <PlayCircle className="size-4" />
            ভিডিওটা দেখো
          </button>
        )}

        {!message.streaming && (
          <button
            type="button"
            onClick={() => {
              setSpeaking(true);
              speak(prose);
              setTimeout(() => setSpeaking(false), 500);
            }}
            className="mt-3 flex items-center gap-1.5 text-xs font-medium text-on-surface-variant hover:text-primary transition-colors"
          >
            <Volume2 className="size-3.5" />
            {speaking ? "পড়া হচ্ছে…" : "জোরে পড়ো"}
          </button>
        )}

        {/* Generated follow-ups, in the student's own voice — these read as
            things a person would say next, so they get the conversational
            treatment. The static pills below are the fallback they were
            always specced to be. */}
        {!message.streaming && suggestions.length > 0 && (
          <div className="mt-4 flex flex-col items-start gap-2">
            {suggestions.map((suggestion) => (
              <motion.button
                key={suggestion}
                type="button"
                whileTap={{ scale: 0.98 }}
                onClick={() => onPillClick?.(suggestion)}
                className="flex max-w-[90%] items-start gap-2 rounded-[20px] rounded-tl-sm border border-outline-variant/30 bg-surface-container-lowest px-4 py-2 text-left text-sm text-on-surface-variant transition-all hover:border-primary/40 hover:bg-surface-container-low shadow-[0_2px_10px_rgba(0,0,0,0.02)]"
              >
                <CornerDownRight className="mt-0.5 size-4 shrink-0 text-primary/50" />
                <span className="min-w-0 font-medium">{suggestion}</span>
              </motion.button>
            ))}
          </div>
        )}

        {!message.streaming && suggestions.length === 0 && actionPills && actionPills.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {actionPills.map((pill) => {
              const Icon = PILL_ICONS[pill.icon];
              return (
                <motion.button
                  key={pill.label}
                  type="button"
                  whileTap={{ scale: 0.96 }}
                  onClick={() => onPillClick?.(pill.prompt)}
                  className="flex items-center gap-1.5 rounded-full border border-outline-variant/30 bg-surface-container-lowest px-3.5 py-1.5 text-xs font-semibold text-on-surface-variant transition-all hover:border-primary/40 hover:text-primary hover:bg-surface-container-low shadow-sm"
                >
                  <Icon className="size-3.5" />
                  {pill.label}
                </motion.button>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
}
