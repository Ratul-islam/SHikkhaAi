import type { CompleteProgressResponse } from "../progress/progress.schema";

/**
 * NCTB papers are built from three question types — MCQ (নৈর্ব্যক্তিক),
 * CQ (সৃজনশীল, the structured "creative question"), and SQ (short question).
 * Phase 1 generates MCQ only, because it's the one type that can be graded
 * deterministically without a second model call per submission. The
 * discriminator is carried on every stored question from day one so CQ/SQ can
 * be added later without migrating existing MasteryAttempt rows.
 */
export type MasteryQuestionType = "MCQ";

export const PASS_THRESHOLD = 70;
export const QUESTION_COUNT = 5;
export const OPTIONS_PER_QUESTION = 4;

/** The full question as persisted on MasteryAttempt.questions — includes the answer key. */
export interface StoredMasteryQuestion {
  id: string;
  questionType: MasteryQuestionType;
  prompt: string;
  options: string[];
  /** Answer key. NEVER serialized to a student — see toClientQuestion(). */
  correctIndex: number;
  /** Shown only after grading, as part of the per-question review. */
  explanation: string;
  /** Textbook page the item was drawn from, when the retrieved chunk carried one. */
  sourcePage: number | null;
}

/** What a student actually receives: the same question minus the answer key and the post-hoc explanation. */
export interface ClientMasteryQuestion {
  id: string;
  questionType: MasteryQuestionType;
  prompt: string;
  options: string[];
}

export function toClientQuestion(q: StoredMasteryQuestion): ClientMasteryQuestion {
  return { id: q.id, questionType: q.questionType, prompt: q.prompt, options: q.options };
}

export interface StartMasteryResponse {
  attemptId: string;
  nodeId: string;
  nodeTitle: string;
  questions: ClientMasteryQuestion[];
  passThreshold: number;
}

export interface SubmittedAnswer {
  questionId: string;
  selectedIndex: number;
}

export interface SubmitMasteryBody {
  answers: SubmittedAnswer[];
}

/** Per-question review returned only after grading — this is where the answer key is finally revealed. */
export interface MasteryQuestionResult {
  questionId: string;
  prompt: string;
  options: string[];
  selectedIndex: number | null;
  correctIndex: number;
  correct: boolean;
  explanation: string;
  sourcePage: number | null;
}

export interface SubmitMasteryResponse {
  attemptId: string;
  nodeId: string;
  score: number;
  passed: boolean;
  passThreshold: number;
  correctCount: number;
  totalQuestions: number;
  results: MasteryQuestionResult[];
  /** Present only when the attempt passed and the node was therefore completed. */
  progress: CompleteProgressResponse | null;
  /** Phase 3 gamification — badges newly earned by this specific submission, for a one-time toast. Empty, not omitted, when none. */
  newBadges: { key: string; title: string; description: string; icon: string }[];
}

export interface ErrorResponse {
  error: string;
}

export const submitMasteryBodySchema = {
  type: "object",
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["questionId", "selectedIndex"],
        properties: {
          questionId: { type: "string", minLength: 1 },
          selectedIndex: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;

/** Structured-output contract for question generation. Mirrors StoredMasteryQuestion minus the server-assigned id. */
export const MASTERY_GENERATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correctIndex: { type: "integer" },
          explanation: { type: "string" },
          sourcePage: { type: "integer" },
        },
        required: ["prompt", "options", "correctIndex", "explanation"],
      },
    },
  },
  required: ["questions"],
} as const;
