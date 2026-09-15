import type { FastifyInstance } from "fastify";
import { Prisma } from "@shikkha-ai/database";
import type { CurriculumNode, LessonSession } from "@shikkha-ai/database";
import { chatClient, CHAT_MODEL } from "../../lib/openai";
import { orchestrate } from "./orchestrator";
import { appendTurn } from "./history.service";
import { recordActivity } from "../../lib/streak";
import type { LessonStep, LessonSessionStatus, StartLessonResponse } from "./lesson.schema";

export class NodeNotFoundError extends Error {}
export class OutlineGenerationError extends Error {}

const MIN_STEPS = 3;
const MAX_STEPS = 6;
/** Roughly how much of a level's own retrieved content we'll hand the outline call — a single level is a fraction of a chapter, so this is deliberately smaller than synthesis.service.ts's chapter-wide window budget. */
const CONTENT_CHAR_BUDGET = 8000;

const OUTLINE_JSON_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          goal: { type: "string" },
        },
        required: ["title", "goal"],
      },
    },
  },
  required: ["steps"],
} as const;

function pageOf(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const page = (metadata as Record<string, unknown>).page;
  return typeof page === "number" ? page : null;
}

/**
 * Pulls the textbook content this node was actually built from. Prefers
 * `sourcePages` (set by Level Synthesis, or by an admin editing a
 * hand-authored node) so the outline is scoped to just this level, not the
 * whole chapter — a chapter can synthesize into several levels, and without
 * this filter every level's lesson would re-teach the same chapter outline.
 * Falls back to the full chapter when no source pages are recorded (an
 * older hand-authored node) — best effort rather than refusing to run.
 */
async function loadNodeContent(app: FastifyInstance, node: CurriculumNode): Promise<string> {
  const rows =
    node.sourcePages.length > 0
      ? await app.prisma.$queryRaw<{ content: string; metadata: unknown }[]>(
          Prisma.sql`
            SELECT content, metadata
            FROM "DocumentChunk"
            WHERE "classLevel" = ${node.classLevel}
              AND "subject" = ${node.subject}
              AND "chapter" = ${node.chapterNumber}
              AND COALESCE((metadata->>'page')::int, -1) = ANY(${node.sourcePages})
            ORDER BY COALESCE((metadata->>'page')::int, 0) ASC, id ASC
          `,
        )
      : await app.prisma.$queryRaw<{ content: string; metadata: unknown }[]>(
          Prisma.sql`
            SELECT content, metadata
            FROM "DocumentChunk"
            WHERE "classLevel" = ${node.classLevel}
              AND "subject" = ${node.subject}
              AND "chapter" = ${node.chapterNumber}
            ORDER BY COALESCE((metadata->>'page')::int, 0) ASC, id ASC
          `,
        );

  let text = "";
  for (const row of rows) {
    if (text.length + row.content.length > CONTENT_CHAR_BUDGET) break;
    text += (text ? "\n\n" : "") + row.content;
  }
  return text;
}

function validateSteps(raw: unknown): LessonStep[] {
  if (!raw || typeof raw !== "object") return [];
  const steps = (raw as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) return [];
  return steps.filter((s): s is LessonStep => {
    if (!s || typeof s !== "object") return false;
    const v = s as Record<string, unknown>;
    return typeof v.title === "string" && v.title.trim().length > 0 && typeof v.goal === "string";
  });
}

/**
 * Synthesizes a short, topic-shaped teaching outline for one node — one
 * model call, done once when a lesson session is created. Deliberately not
 * raw DocumentChunks: chunk boundaries are RAG-retrieval-shaped (fixed
 * character windows), not concept-shaped, so walking them directly would
 * make the AI "teach" mid-sentence breaks as if they were topic boundaries.
 */
export async function generateOutline(app: FastifyInstance, node: CurriculumNode): Promise<LessonStep[]> {
  const content = await loadNodeContent(app, node);
  if (!content) {
    throw new OutlineGenerationError(
      `No ingested content found for "${node.title}" (Class ${node.classLevel} ${node.subject} ch.${node.chapterNumber})`,
    );
  }

  const completion = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `You are preparing to teach one roadmap level to an NCTB Class ${node.classLevel} ${node.subject} student: "${node.title}" — ${node.description}.
Break the textbook content below into between ${MIN_STEPS} and ${MAX_STEPS} sequential teaching steps — each step is one sitting's worth of a single idea, in the order a student should learn them. This is NOT a chapter-level split (that already happened); it's how you personally would pace teaching this one level turn by turn.
For each step give a short \`title\` (student-facing, under 60 characters) and a one-sentence \`goal\` (what they can do after this step).
Write titles/goals in the same language the content below is written in.`,
      },
      { role: "user", content },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "lesson_outline", schema: OUTLINE_JSON_SCHEMA },
    },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "");
  } catch {
    throw new OutlineGenerationError("Model returned unparseable JSON for the lesson outline");
  }

  const steps = validateSteps(parsed).slice(0, MAX_STEPS);
  if (steps.length === 0) {
    throw new OutlineGenerationError("Model produced no usable outline steps");
  }
  return steps;
}

/**
 * Creates (or resumes) this student's guided-lesson session for a node.
 *
 * A brand-new session synthesizes the outline and produces the AI's first
 * proactive turn — persisted into the same ChatMessage thread a reactive
 * chat turn would use, via orchestrate()'s `lessonContext.isKickoff` path
 * (see orchestrator.ts) so it's one call, not a parallel pipeline.
 *
 * Resuming an already-ACTIVE session deliberately does NOT call the model
 * again — the outline and progress are already settled, and the student's
 * existing history (GET /chat/history) already shows what was taught.
 */
export async function startOrResumeLesson(
  app: FastifyInstance,
  userId: string,
  nodeId: string,
): Promise<StartLessonResponse> {
  const node = await app.prisma.curriculumNode.findUnique({ where: { id: nodeId } });
  if (!node) throw new NodeNotFoundError(`CurriculumNode ${nodeId} not found`);

  // No prerequisite gate here: a student can start any level's guided lesson
  // regardless of roadmap order (product decision — the LOCKED/UNLOCKED
  // status shown on the roadmap is a recommended path, not an access
  // control). completeNode() in progress.service.ts is the one place that
  // ever cared about lock status for real, and it dropped the same check.

  const existing = await app.prisma.lessonSession.findUnique({ where: { userId_nodeId: { userId, nodeId } } });
  if (existing) {
    return {
      sessionId: existing.id,
      nodeId,
      nodeTitle: node.title,
      subject: node.subject,
      chapter: node.chapterNumber,
      outline: existing.outline as unknown as LessonStep[],
      currentStep: existing.currentStep,
      status: existing.status as LessonSessionStatus,
      turn: null,
    };
  }

  const outline = await generateOutline(app, node);

  const firstStep = outline[0]!;
  const result = await orchestrate(app, {
    userId,
    // Framing only — this is never shown to the student and never persisted
    // as a user ChatMessage (see below); it exists purely so orchestrate()
    // has a "message" to attach the kickoff instruction to.
    message: "(lesson kickoff — no student message yet)",
    subject: node.subject,
    chapter: node.chapterNumber,
    history: [],
    lessonContext: {
      isKickoff: true,
      stepIndex: 0,
      totalSteps: outline.length,
      stepTitle: firstStep.title,
      stepGoal: firstStep.goal,
    },
  });

  // Only the assistant's turn is persisted — nothing was actually said by
  // the student, so there is no matching "user" ChatMessage to write.
  await appendTurn(app, {
    userId,
    subject: node.subject,
    chapter: node.chapterNumber,
    role: "assistant",
    content: result.content,
    responseType: result.responseType,
    reasoning: result.reasoning,
    videoBrief: result.videoBrief,
    visualHtml: result.visualHtml,
    suggestions: result.suggestions,
  });

  const session = await app.prisma.lessonSession.create({
    data: {
      userId,
      nodeId,
      status: "ACTIVE",
      currentStep: 0,
      outline: outline as unknown as Prisma.InputJsonValue,
    },
  });

  // A lesson kickoff doesn't go through chat.service.ts (its own turns
  // afterward do, and record activity there) — this is its own activity
  // signal so starting a lesson counts toward the streak too.
  recordActivity(app, userId).catch((err) => app.log.error(err, "Failed to record activity for streak"));

  return {
    sessionId: session.id,
    nodeId,
    nodeTitle: node.title,
    subject: node.subject,
    chapter: node.chapterNumber,
    outline,
    currentStep: 0,
    status: "ACTIVE",
    turn: {
      responseType: result.responseType,
      reasoning: result.reasoning,
      content: result.content,
      videoBrief: result.videoBrief,
      visualHtml: result.visualHtml,
      suggestions: result.suggestions,
    },
  };
}

export interface ActiveLessonContext {
  session: LessonSession;
  outline: LessonStep[];
  stepIndex: number;
  totalSteps: number;
  stepTitle: string;
  stepGoal: string;
  isLastStep: boolean;
}

/**
 * Looked up by chat.service.ts on every /chat call that names a nodeId —
 * this is the integration point the audit called for: lesson state feeds
 * the *same* orchestrator decision a reactive turn already makes, rather
 * than a parallel "lesson mode" code path. Returns null when there's no
 * active session, or the outline is already exhausted (nothing left to
 * weave in — the reactive answer stands on its own).
 */
export async function getActiveLessonContext(
  app: FastifyInstance,
  userId: string,
  nodeId: string,
): Promise<ActiveLessonContext | null> {
  const session = await app.prisma.lessonSession.findUnique({ where: { userId_nodeId: { userId, nodeId } } });
  if (!session || session.status !== "ACTIVE") return null;

  const outline = session.outline as unknown as LessonStep[];
  if (session.currentStep >= outline.length) return null;

  const step = outline[session.currentStep]!;
  return {
    session,
    outline,
    stepIndex: session.currentStep,
    totalSteps: outline.length,
    stepTitle: step.title,
    stepGoal: step.goal,
    isLastStep: session.currentStep === outline.length - 1,
  };
}

/**
 * Called by chat.service.ts once the orchestrator call that wove in
 * `context`'s step has actually succeeded and been persisted — advances to
 * the next step, or flips to READY_FOR_MASTERY once the outline is spent.
 * This is a DB write only, never a second model call.
 */
export async function advanceLessonSession(app: FastifyInstance, context: ActiveLessonContext): Promise<void> {
  await app.prisma.lessonSession.update({
    where: { id: context.session.id },
    data: context.isLastStep
      ? { status: "READY_FOR_MASTERY" }
      : { currentStep: context.stepIndex + 1 },
  });
}
