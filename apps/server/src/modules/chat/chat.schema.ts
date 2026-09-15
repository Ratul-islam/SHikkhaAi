import type { ResponseType } from "./orchestrator";
import type { VideoBrief } from "../video/director.schema";

/**
 * `history` is deliberately absent — as of Phase 1.5 it's server-side
 * conversation memory (history.service.ts), loaded by userId+subject+chapter,
 * not client-supplied. A client sending one now gets it silently ignored by
 * the schema's own `additionalProperties: false` below.
 */
export interface ChatRequestBody {
  message: string;
  subject: string;
  chapter: number;
  /** Differentiates separate conversations for the same (subject, chapter) — see history.service.ts. Omitted (defaults to 1) by every caller except the explicit "new conversation" flow. */
  conversationSlot?: number;
  /**
   * A Topic inside this chapter the student narrowed the conversation to.
   * Only honoured when it belongs to the student's own grade and this exact
   * chapter (chat.service.ts); it narrows retrieval, never widens it.
   */
  topicId?: string;
  /**
   * Phase 6 — set by the frontend while a guided lesson is open for this
   * node (returned from POST /lessons/:nodeId/start). Lets chat.service.ts
   * look up an active LessonSession and weave the next outline step into
   * this same reactive turn. Omitted entirely for ordinary reactive chat —
   * this is additive, not a mode switch the rest of the request shape cares about.
   */
  nodeId?: string;
}

/** A read-only view of the student's adaptive profile, for the "Tutor Mode" badge (PLAN.md Phase 8 §4). Reflects the profile going into this turn — the evaluator's write for this turn lands after the response is sent. */
export interface ProfileSnapshot {
  classLevel: number;
  visualPreferenceScore: number;
  languageMix: string;
  tutorModeLabel: string;
}

export interface ChatResponse {
  responseType: ResponseType;
  reasoning: string;
  content: string;
  /**
   * What a VIDEO turn carries now — the brief the client hands to
   * /video/build, which directs and renders the lesson server-side.
   */
  videoBrief?: VideoBrief;
  /**
   * The interactive widget's markup for a CANVAS turn. Declared in
   * RESPONSE_JSON_SCHEMA and prompted for since Phase 4, but never actually
   * carried past the orchestrator's parser until now — which is why every
   * CANVAS turn used to open an empty visual panel.
   */
  visualHtml?: string;
  /** Follow-up messages in the student's own voice, rendered as tappable chips. Absent falls back to ChatMessage.tsx's static pills. */
  suggestions?: string[];
  profileSnapshot: ProfileSnapshot;
}

export interface ErrorResponse {
  error: string;
}

export interface ChatTopicOption {
  id: string;
  /** "2.3" */
  code: string;
  title: string;
}

/** One askable chapter for the chat picker, for the caller's own grade. */
export interface ChatChapterOption {
  subject: string;
  chapter: number;
  /** The textbook chapter's title; a level's title for a chapter with levels but no ingested book; null when neither exists. */
  title: string | null;
  /** Empty for a chapter ingested before whole-book ingestion, or known only from roadmap levels. */
  topics: ChatTopicOption[];
}

export interface ChatTopicsResponse {
  chapters: ChatChapterOption[];
}

export const chatBodySchema = {
  type: "object",
  required: ["message", "subject", "chapter"],
  properties: {
    message: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    chapter: { type: "integer", minimum: 1 },
    conversationSlot: { type: "integer", minimum: 1 },
    topicId: { type: "string", format: "uuid" },
    nodeId: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
} as const;
