import type { ResponseType } from "./orchestrator";
import type { VideoBrief } from "../video/director.schema";

export type LessonSessionStatus = "ACTIVE" | "READY_FOR_MASTERY" | "ABANDONED";

/** One teaching step in a node's guided-lesson outline — synthesized once per session, see lesson.service.ts's generateOutline. */
export interface LessonStep {
  title: string;
  /** One sentence: what the student should be able to do after this step. */
  goal: string;
}

/** The proactive teaching turn produced when a lesson session is created — same shape as a normal chat reply, minus profileSnapshot (the caller already has one from the surrounding /chat flow if it needs it). */
export interface LessonTurn {
  responseType: ResponseType;
  reasoning: string;
  content: string;
  videoBrief?: VideoBrief;
  /** Same as ChatResponse's — a kickoff turn is a normal orchestrator result and can carry a widget. */
  visualHtml?: string;
  suggestions?: string[];
}

export interface StartLessonResponse {
  sessionId: string;
  nodeId: string;
  nodeTitle: string;
  subject: string;
  chapter: number;
  outline: LessonStep[];
  currentStep: number;
  status: LessonSessionStatus;
  /**
   * Present only when this call created a brand-new session — the AI's
   * first proactive turn, already persisted into ChatMessage. Null when
   * resuming an already-ACTIVE session: regenerating it would both waste a
   * model call and duplicate content already in history (loaded via the
   * existing GET /chat/history instead).
   */
  turn: LessonTurn | null;
}

export interface ErrorResponse {
  error: string;
}
