"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { isAxiosError } from "axios";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { CheckCircle2, Loader2, ListChecks, RotateCcw, Sparkles, XCircle } from "lucide-react";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type {
  MasteryQuestionResult,
  StartMasteryResponse,
  SubmitMasteryResponse,
} from "../../lib/types";

/** Inline markdown+KaTeX, matching how ChatMessage renders tutor prose. */
function Prose({ children, className }: { children: string; className?: string }): JSX.Element {
  return (
    <div className={cn("prose-sm max-w-none [&_p]:m-0", className)}>
      <ReactMarkdown remarkPlugins={[remarkMath]} rehypePlugins={[rehypeKatex]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

const OPTION_LABELS = ["ক", "খ", "গ", "ঘ", "ঙ", "চ"];

type Phase = "idle" | "loading" | "answering" | "grading" | "graded";

export interface MasteryCheckPanelProps {
  nodeId: string;
  /** Fired after a pass, so the parent can refresh XP / roadmap state. */
  onPassed?: (result: SubmitMasteryResponse) => void;
}

/**
 * The student-facing Mastery Check: the gate that decides whether a level is
 * complete.
 *
 * The answer key never reaches this component before grading — questions
 * arrive without it, answers are POSTed back, and the server returns both the
 * score and the per-question review. That's deliberate: the score has to be
 * something only the server could have produced.
 */
export default function MasteryCheckPanel({ nodeId, onPassed }: MasteryCheckPanelProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [attempt, setAttempt] = useState<StartMasteryResponse | null>(null);
  const [selections, setSelections] = useState<Record<string, number>>({});
  const [result, setResult] = useState<SubmitMasteryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function startCheck(): Promise<void> {
    setOpen(true);
    setPhase("loading");
    setError(null);
    setAttempt(null);
    setResult(null);
    setSelections({});

    try {
      const response = await api.post<StartMasteryResponse>(`/mastery/${nodeId}/start`);
      setAttempt(response.data);
      setPhase("answering");
    } catch (err) {
      const msg = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(msg ?? "Couldn't start the mastery check.");
      setPhase("idle");
    }
  }

  async function submit(): Promise<void> {
    if (!attempt) return;
    setPhase("grading");
    setError(null);

    try {
      const answers = Object.entries(selections).map(([questionId, selectedIndex]) => ({
        questionId,
        selectedIndex,
      }));
      const response = await api.post<SubmitMasteryResponse>(`/mastery/${attempt.attemptId}/submit`, {
        answers,
      });
      setResult(response.data);
      setPhase("graded");
      if (response.data.passed) onPassed?.(response.data);
    } catch (err) {
      const msg = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(msg ?? "Couldn't grade your answers.");
      setPhase("answering");
    }
  }

  const answeredCount = attempt ? attempt.questions.filter((q) => q.id in selections).length : 0;
  const allAnswered = attempt !== null && answeredCount === attempt.questions.length;

  return (
    <>
      <Button onClick={startCheck} className="bg-primary">
        <ListChecks className="size-4" />
        Take mastery check
      </Button>
      {error && !open && <p className="text-sm text-destructive">{error}</p>}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 bg-surface-container-lowest shadow-xl sm:max-w-xl">
          <SheetHeader className="border-b border-outline-variant/30">
            <SheetTitle className="flex items-center gap-2">
              <ListChecks className="size-4 text-primary" />
              Mastery Check
            </SheetTitle>
            <SheetDescription>
              {attempt ? attempt.nodeTitle : "Preparing your questions…"}
              {attempt && phase === "answering" && (
                <>
                  {" · "}
                  {answeredCount}/{attempt.questions.length} answered · pass at {attempt.passThreshold}%
                </>
              )}
            </SheetDescription>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto px-4 py-4">
            {phase === "loading" && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-sm text-foreground/50">
                <Loader2 className="size-6 animate-spin text-primary" />
                Writing questions from your textbook…
              </div>
            )}

            {phase === "grading" && (
              <div className="flex flex-col items-center justify-center gap-3 py-16 text-center text-sm text-foreground/50">
                <Loader2 className="size-6 animate-spin text-primary" />
                Marking your answers…
              </div>
            )}

            {(phase === "answering" || (phase === "grading" && !result)) && attempt && (
              <div className="flex flex-col gap-5">
                {attempt.questions.map((question, qi) => (
                  <div key={question.id} className="rounded-xl border border-outline-variant/30 bg-surface-container-low p-4">
                    <div className="flex gap-2">
                      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                        {qi + 1}
                      </span>
                      <Prose className="text-sm font-medium">{question.prompt}</Prose>
                    </div>

                    <div className="mt-3 flex flex-col gap-2">
                      {question.options.map((option, oi) => {
                        const selected = selections[question.id] === oi;
                        return (
                          <button
                            key={oi}
                            type="button"
                            onClick={() => setSelections((s) => ({ ...s, [question.id]: oi }))}
                            className={cn(
                              "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                              selected
                                ? "border-primary bg-accent text-primary"
                                : "border-input hover:border-primary/40 hover:bg-accent/40",
                            )}
                          >
                            <span
                              className={cn(
                                "mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold",
                                selected
                                  ? "border-primary bg-primary text-primary-foreground"
                                  : "border-input text-foreground/50",
                              )}
                            >
                              {OPTION_LABELS[oi] ?? oi + 1}
                            </span>
                            <Prose className="flex-1">{option}</Prose>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}

                {error && <p className="text-sm text-destructive">{error}</p>}
              </div>
            )}

            {phase === "graded" && result && (
              <ResultView result={result} onRetry={startCheck} />
            )}
          </div>

          {phase === "answering" && attempt && (
            <div className="border-t border-outline-variant/30 p-4">
              <Button onClick={submit} disabled={!allAnswered} className="w-full">
                {allAnswered
                  ? "Submit answers"
                  : `Answer all ${attempt.questions.length} questions to submit`}
              </Button>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}

function ResultView({
  result,
  onRetry,
}: {
  result: SubmitMasteryResponse;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-5">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "flex flex-col items-center gap-1 rounded-xl border p-6 text-center",
          result.passed ? "border-primary/30 bg-accent" : "border-coral/30 bg-coral/5",
        )}
      >
        <span
          className={cn(
            "text-4xl font-semibold tabular-nums",
            result.passed ? "text-primary" : "text-coral",
          )}
        >
          {result.score}%
        </span>
        <p className="text-sm font-medium">
          {result.passed ? "Level cleared — nice one!" : "Almost there."}
        </p>
        <p className="text-xs text-foreground/50">
          {result.correctCount} of {result.totalQuestions} correct · pass at {result.passThreshold}%
        </p>

        {result.passed && result.progress && result.progress.xpAwarded > 0 && (
          <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-amber/15 px-3 py-1 text-xs font-semibold text-amber-foreground">
            <Sparkles className="size-3.5" />+{result.progress.xpAwarded} XP
          </span>
        )}
        {result.passed && result.progress && result.progress.newlyUnlockedNodeIds.length > 0 && (
          <p className="mt-1 text-xs text-primary">
            Unlocked {result.progress.newlyUnlockedNodeIds.length} new level
            {result.progress.newlyUnlockedNodeIds.length === 1 ? "" : "s"}.
          </p>
        )}

        {result.newBadges.length > 0 && (
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {result.newBadges.map((b) => (
              <span
                key={b.key}
                title={b.description}
                className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant/30 bg-surface-container-low px-3 py-1 text-xs font-medium"
              >
                <span className="text-base">{b.icon}</span>
                New badge: {b.title}
              </span>
            ))}
          </div>
        )}
      </motion.div>

      {!result.passed && (
        <Button onClick={onRetry} variant="secondary" className="self-center">
          <RotateCcw className="size-4" />
          Try again
        </Button>
      )}

      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold text-foreground/70">Review</h3>
        {result.results.map((r, i) => (
          <QuestionReview key={r.questionId} index={i} result={r} />
        ))}
      </div>
    </div>
  );
}

function QuestionReview({ index, result }: { index: number; result: MasteryQuestionResult }): JSX.Element {
  return (
    <div
      className={cn(
        "rounded-xl border p-4",
        result.correct ? "border-primary/25 bg-accent/50" : "border-coral/25 bg-coral/5",
      )}
    >
      <div className="flex gap-2">
        {result.correct ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-coral" />
        )}
        <Prose className="text-sm font-medium">{`${index + 1}. ${result.prompt}`}</Prose>
      </div>

      <div className="mt-2.5 flex flex-col gap-1.5">
        {result.options.map((option, oi) => {
          const isCorrect = oi === result.correctIndex;
          const isChosen = oi === result.selectedIndex;
          if (!isCorrect && !isChosen) return null;
          return (
            <div
              key={oi}
              className={cn(
                "flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-sm",
                isCorrect ? "bg-primary/10 text-primary" : "bg-coral/10 text-coral",
              )}
            >
              <span className="mt-px text-[11px] font-semibold">{OPTION_LABELS[oi] ?? oi + 1}</span>
              <Prose className="flex-1">{option}</Prose>
              <span className="shrink-0 text-[11px] font-medium opacity-70">
                {isCorrect ? "correct" : "you chose"}
              </span>
            </div>
          );
        })}
        {result.selectedIndex === null && (
          <p className="px-2.5 text-xs text-foreground/50">You didn&apos;t answer this one.</p>
        )}
      </div>

      <div className="mt-2.5 border-t border-outline-variant/30 pt-2.5">
        <Prose className="text-xs text-foreground/70">{result.explanation}</Prose>
        {result.sourcePage !== null && (
          <p className="mt-1 text-[11px] text-foreground/40">Textbook page {result.sourcePage}</p>
        )}
      </div>
    </div>
  );
}
