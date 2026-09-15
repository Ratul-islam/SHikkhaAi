"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { GraduationCap } from "lucide-react";
import type { ChatStage } from "../../lib/streamChat";

const STAGE_LABELS: Record<ChatStage, string> = {
  retrieving: "পাঠ্যবই পড়া হচ্ছে…",
  thinking: "চিন্তা করা হচ্ছে…",
  saving: "গুছিয়ে নেওয়া হচ্ছে…",
};

/**
 * `thinking` is one long model call that decides the modality, writes the
 * explanation and may draw an interactive widget — comfortably 10-30s on a
 * CANVAS or VIDEO turn, where a single frozen label reads as a hang.
 *
 * These rotate on elapsed time, and they are deliberately phrased as what
 * that one call is *producing* rather than as sub-steps the server reported:
 * there is no progress signal inside a single completion, and pretending
 * otherwise would be a fake progress bar. The real server-reported stages
 * are still what switch between retrieving/thinking/saving.
 */
const THINKING_LABELS = [
  "চিন্তা করা হচ্ছে…",
  "ব্যাখ্যাটা সাজানো হচ্ছে…",
  "একটা ভালো উপমা খুঁজছি…",
  "প্রায় হয়ে এসেছে…",
];
const THINKING_ROTATE_MS = 4000;

/**
 * Shown in place of the assistant's message bubble while a turn is in
 * flight — real stage labels from the server (chat.service.ts's
 * `onStage`), not a fake progress bar. Bouncing-dot avatar mirrors
 * ChatMessage.tsx's own persona avatar so this reads as "the tutor is
 * about to reply" rather than a generic spinner.
 */
export default function ThinkingIndicator({ stage }: { stage: ChatStage | null }): JSX.Element {
  const [thinkingStep, setThinkingStep] = useState(0);

  useEffect(() => {
    if (stage !== "thinking") {
      setThinkingStep(0);
      return;
    }
    // Stops at the last label rather than looping — cycling back to
    // "চিন্তা করা হচ্ছে…" after 20s would read as being stuck in a loop.
    const timer = setInterval(() => {
      setThinkingStep((step) => Math.min(THINKING_LABELS.length - 1, step + 1));
    }, THINKING_ROTATE_MS);
    return () => clearInterval(timer);
  }, [stage]);

  const label =
    stage === "thinking" ? THINKING_LABELS[thinkingStep] : stage ? STAGE_LABELS[stage] : "একটু অপেক্ষা করুন…";

  return (
    <div className="flex gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary-fixed/50 text-primary">
        <GraduationCap className="size-4" />
      </div>
      <div className="flex items-center gap-2 text-sm text-on-surface-variant">
        <span className="flex gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-1.5 rounded-full bg-primary/60"
              animate={{ y: [0, -4, 0] }}
              transition={{ duration: 0.6, repeat: Infinity, delay: i * 0.15, ease: "easeInOut" }}
            />
          ))}
        </span>
        <AnimatePresence mode="wait">
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2 }}
          >
            {label}
          </motion.span>
        </AnimatePresence>
      </div>
    </div>
  );
}
