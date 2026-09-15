import type { FastifyInstance } from "fastify";
import { orchestrate } from "./orchestrator";
import { evaluateAndAdaptProfile } from "./evaluator";
import { appendTurn, loadRecentHistoryForPrompt } from "./history.service";
import { advanceLessonSession, getActiveLessonContext } from "./lesson.service";
import { recordActivity } from "../../lib/streak";
import type { ChatRequestBody, ChatResponse, ProfileSnapshot } from "./chat.schema";

function buildTutorModeLabel(classLevel: number, visualPreferenceScore: number, languageMix: string): string {
  const visualLabel =
    visualPreferenceScore > 0.6 ? "High Visual Preference" : visualPreferenceScore < 0.4 ? "Text-First" : "Balanced";
  const languageLabel = languageMix === "BANGLA" ? "Bangla" : languageMix === "BANGLISH" ? "Banglish" : "English";
  return `Adapted for Class ${classLevel} · ${visualLabel} · ${languageLabel}`;
}

/**
 * Progress stages emitted while a turn is in flight — real steps this
 * function actually passes through, not a fake animation. Consumed by
 * chat.routes.ts's SSE route so the frontend can show "thinking" state
 * instead of a blank wait; generateChatReply itself doesn't know or care
 * whether anyone's listening.
 */
export type ChatStage = "retrieving" | "thinking" | "saving";

interface StudyFocus {
  chapterTitle: string | null;
  topic: { id: string; code: string; title: string } | null;
}

/**
 * The committed chapter's title and, when the student narrowed to one, its
 * topic. Both are looked up under the student's OWN grade and this exact
 * chapter, so a topicId from another class or chapter is dropped here rather
 * than ever reaching retrieval.
 */
async function resolveStudyFocus(
  app: FastifyInstance,
  params: { classLevel: number; subject: string; chapter: number; topicId?: string },
): Promise<StudyFocus> {
  const chapter = await app.prisma.chapter.findUnique({
    where: { classLevel_subject_number: { classLevel: params.classLevel, subject: params.subject, number: params.chapter } },
    select: { id: true, title: true },
  });
  if (!chapter) return { chapterTitle: null, topic: null };
  const topic = params.topicId
    ? await app.prisma.topic.findFirst({
        where: { id: params.topicId, chapterId: chapter.id },
        select: { id: true, code: true, title: true },
      })
    : null;
  return { chapterTitle: chapter.title, topic };
}

export async function generateChatReply(
  app: FastifyInstance,
  userId: string,
  body: ChatRequestBody,
  onStage?: (stage: ChatStage) => void,
): Promise<ChatResponse> {
  // Read the profile as it stands going into this turn — the badge should reflect the state the
  // student is being adapted to right now, not a value the evaluator hasn't written yet.
  // Defaults to the one conversation every existing entry point has always
  // used (see history.service.ts) — only the explicit "new conversation"
  // flow ever sends a slot past 1.
  const conversationSlot = body.conversationSlot ?? 1;

  onStage?.("retrieving");
  const [user, profile, history] = await Promise.all([
    app.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    app.prisma.userProfile.upsert({ where: { userId }, create: { userId }, update: {} }),
    // Server-side conversation memory (Phase 1.5) — replaces the old client-supplied,
    // client-truncated, refresh-losing `history` field. See history.service.ts.
    loadRecentHistoryForPrompt(app, userId, body.subject, body.chapter, conversationSlot),
  ]);
  const profileSnapshot: ProfileSnapshot = {
    classLevel: user.classLevel,
    visualPreferenceScore: profile.visualPreferenceScore,
    languageMix: profile.languageMix,
    tutorModeLabel: buildTutorModeLabel(user.classLevel, profile.visualPreferenceScore, profile.languageMix),
  };

  const focus = await resolveStudyFocus(app, {
    classLevel: user.classLevel,
    subject: body.subject,
    chapter: body.chapter,
    topicId: body.topicId,
  });

  // Phase 6: if this turn names a node with an active guided-lesson session,
  // fold the next outline step into this same orchestrator call rather than
  // running a parallel "lesson mode" pipeline — see orchestrator.ts's
  // `lessonContext` param and CLAUDE.md's "decide modality every turn" rule.
  const lesson = body.nodeId ? await getActiveLessonContext(app, userId, body.nodeId) : null;

  onStage?.("thinking");
  const result = await orchestrate(app, {
    userId,
    message: body.message,
    subject: body.subject,
    chapter: body.chapter,
    chapterTitle: focus.chapterTitle ?? undefined,
    topic: focus.topic ?? undefined,
    history,
    lessonContext: lesson
      ? {
          isKickoff: false,
          stepIndex: lesson.stepIndex,
          totalSteps: lesson.totalSteps,
          stepTitle: lesson.stepTitle,
          stepGoal: lesson.stepGoal,
        }
      : undefined,
  });

  onStage?.("saving");

  // Persisted (not fire-and-forget) — this is now the source of truth for the
  // conversation, unlike the evaluator's soft profile nudge below. A silent
  // failure here would mean the reply the student just read never actually
  // got saved, which is exactly the regression this feature replaces.
  //
  // Sequential, not Promise.all: history.service orders by createdAt, and two
  // concurrent inserts can land in the same instant with no guaranteed
  // relative order — the user's turn must be written (and its timestamp
  // fixed) before the assistant's, or history can come back reply-then-question.
  await appendTurn(app, {
    userId,
    subject: body.subject,
    chapter: body.chapter,
    conversationSlot,
    topicId: focus.topic?.id,
    role: "user",
    content: body.message,
  });
  await appendTurn(app, {
    userId,
    subject: body.subject,
    chapter: body.chapter,
    conversationSlot,
    topicId: focus.topic?.id,
    role: "assistant",
    content: result.content,
    responseType: result.responseType,
    reasoning: result.reasoning,
    videoBrief: result.videoBrief,
    visualHtml: result.visualHtml,
    suggestions: result.suggestions,
  });

  // Advance the outline only after the woven-in step has actually been
  // generated and persisted above — a DB write, never a second model call.
  if (lesson) {
    await advanceLessonSession(app, lesson);
  }

  // Closes [GAP-4] (PLAN.md Phase 3 §3.2) — a chat turn is this app's most
  // frequent activity signal, so this is the single call site that keeps
  // streakDays honest for the overwhelming majority of students.
  recordActivity(app, userId).catch((err) => app.log.error(err, "Failed to record activity for streak"));

  // Fire-and-forget: don't make the student wait on a profile write to see their answer.
  evaluateAndAdaptProfile(app, {
    userId,
    message: body.message,
    subject: body.subject,
    chapter: body.chapter,
    responseType: result.responseType,
  }).catch((err) => {
    app.log.error(err, "Failed to update learning profile after chat turn");
  });

  return { ...result, profileSnapshot };
}
