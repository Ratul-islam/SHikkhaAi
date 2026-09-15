"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Sparkles } from "lucide-react";
import type { ProfileSnapshot } from "../lib/types";

/**
 * Live "Tutor Mode" badge (PLAN.md Phase 8 §4) — reflects the profile the
 * student was adapted to as of the most recent chat response. It updates
 * one turn behind the evaluator's own writes, same as the profile data
 * itself (see chat.service.ts's profileSnapshot comment).
 */
export default function TutorModeBadge({ snapshot }: { snapshot: ProfileSnapshot | null }): JSX.Element | null {
  if (!snapshot) return null;

  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={snapshot.tutorModeLabel}
        initial={{ opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -4 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-1.5 rounded-full bg-primary-fixed/40 px-3 py-1 text-xs font-medium text-on-primary-fixed-variant"
      >
        <Sparkles className="size-3.5 text-primary" />
        {snapshot.tutorModeLabel}
      </motion.div>
    </AnimatePresence>
  );
}
