import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@shikkha-ai/database";
import { chatClient, CHAT_MODEL, embedText } from "../../lib/openai";
import { searchDocumentChunks } from "../../lib/vectorSearch";
import { PERSONA_DESCRIPTION } from "../chat/prompt";
import { completeNode } from "../progress/progress.service";
import { applyMasteryResultToProfile } from "../chat/evaluator";
import { recordActivity } from "../../lib/streak";
import {
  evaluateChapterClearedBadge,
  evaluateMasteryBadges,
  evaluateStreakBadges,
  type BadgeAward,
} from "../badges/badges.service";
import {
  MASTERY_GENERATION_JSON_SCHEMA,
  OPTIONS_PER_QUESTION,
  PASS_THRESHOLD,
  QUESTION_COUNT,
  toClientQuestion,
  type MasteryQuestionResult,
  type StartMasteryResponse,
  type StoredMasteryQuestion,
  type SubmitMasteryResponse,
  type SubmittedAnswer,
} from "./mastery.schema";

export class NodeNotFoundError extends Error {}
export class AttemptNotFoundError extends Error {}
export class AttemptAlreadySubmittedError extends Error {}
export class QuestionGenerationError extends Error {}

/** Enough chunks to build QUESTION_COUNT distinct questions without asking the same thing five times. */
const RETRIEVAL_LIMIT = 8;
/** PLAN.md Phase 3 §3.2 — a flat 10% XP bonus for passing on the first attempt. */
const FIRST_ATTEMPT_XP_BONUS_RATE = 0.1;

interface GeneratedQuestion {
  prompt: string;
  options: string[];
  correctIndex: number;
  explanation: string;
  sourcePage?: number;
}

function pageOf(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== "object") return null;
  const page = (metadata as Record<string, unknown>).page;
  return typeof page === "number" ? page : null;
}

function buildGenerationPrompt(params: {
  nodeTitle: string;
  nodeDescription: string;
  subject: string;
  classLevel: number;
  chapter: number;
  contextChunks: { content: string; page: number | null }[];
}): string {
  const { nodeTitle, nodeDescription, subject, classLevel, chapter, contextChunks } = params;

  const contextBlock =
    contextChunks.length > 0
      ? contextChunks.map((c, i) => `[${i + 1}${c.page ? ` p.${c.page}` : ""}] ${c.content}`).join("\n\n")
      : "(No matching NCTB textbook content was found. Write questions from general NCTB curriculum knowledge for this class and subject, and keep them conservative — only test what is unambiguously part of this topic.)";

  return [
    PERSONA_DESCRIPTION,
    `You are writing a Mastery Check: a short NCTB-style MCQ paper that decides whether a student has actually understood one roadmap level. This is a graded gate, not a chat turn — so drop the tutoring voice entirely and write exam questions.`,
    `Level: "${nodeTitle}" — ${nodeDescription}
Subject: ${subject} · Class ${classLevel} · Chapter ${chapter}`,
    `Write exactly ${QUESTION_COUNT} MCQ questions. Rules:
- Exactly ${OPTIONS_PER_QUESTION} options per question, and exactly one unambiguously correct answer.
- \`correctIndex\` is the 0-based index of the correct option. Vary which position is correct across the paper — do not make it index 0 every time.
- Distractors must be plausible to a student who half-understands the topic. Never use "all of the above", "none of the above", or joke options.
- Test understanding and application, not recall of a sentence's exact wording.
- Ground every question in the textbook context below. Set \`sourcePage\` to the page number shown in the context entry you used, when one is shown.
- \`explanation\` is shown to the student AFTER they answer: one or two sentences on why the correct option is right, in your usual warm voice. If they got it wrong, this is what teaches them — treat a wrong answer as "almost there", never as a failure.
- Use clean KaTeX for any math ($...$ inline, $$...$$ block).
- Write the questions in the same language the textbook context is written in.`,
    `NCTB textbook context:\n${contextBlock}`,
  ].join("\n\n");
}

/** Keeps only questions that are actually gradable — a malformed item would silently corrupt the score. */
function validateGenerated(raw: unknown): GeneratedQuestion[] {
  if (!raw || typeof raw !== "object") return [];
  const questions = (raw as Record<string, unknown>).questions;
  if (!Array.isArray(questions)) return [];

  return questions.filter((q): q is GeneratedQuestion => {
    if (!q || typeof q !== "object") return false;
    const v = q as Record<string, unknown>;
    if (typeof v.prompt !== "string" || !v.prompt.trim()) return false;
    if (typeof v.explanation !== "string") return false;
    if (!Array.isArray(v.options) || v.options.length < 2) return false;
    if (!v.options.every((o) => typeof o === "string" && o.trim())) return false;
    if (typeof v.correctIndex !== "number" || !Number.isInteger(v.correctIndex)) return false;
    return v.correctIndex >= 0 && v.correctIndex < v.options.length;
  });
}

async function generateQuestions(
  app: FastifyInstance,
  params: Parameters<typeof buildGenerationPrompt>[0],
): Promise<StoredMasteryQuestion[]> {
  const systemPrompt = buildGenerationPrompt(params);

  const completion = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Write the ${QUESTION_COUNT}-question Mastery Check for "${params.nodeTitle}" now.` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "mastery_paper", schema: MASTERY_GENERATION_JSON_SCHEMA },
    },
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(completion.choices[0]?.message?.content ?? "");
  } catch {
    throw new QuestionGenerationError("Model returned unparseable JSON for the mastery paper");
  }

  const valid = validateGenerated(parsed);
  // Unlike a chat turn, this cannot degrade gracefully — a paper with two
  // usable questions would make the pass threshold meaningless, so fail loudly
  // and let the student retry rather than grade them on a broken paper.
  if (valid.length < QUESTION_COUNT) {
    throw new QuestionGenerationError(
      `Model produced only ${valid.length} valid questions (needed ${QUESTION_COUNT})`,
    );
  }

  return valid.slice(0, QUESTION_COUNT).map((q) => ({
    id: randomUUID(),
    questionType: "MCQ" as const,
    prompt: q.prompt,
    options: q.options,
    correctIndex: q.correctIndex,
    explanation: q.explanation,
    sourcePage: typeof q.sourcePage === "number" ? q.sourcePage : null,
  }));
}

/**
 * Starts a Mastery Check for one level.
 *
 * The generated paper — answer key included — is persisted server-side, and
 * only the answer-key-free projection is returned. That's what makes the
 * resulting score unforgeable: the client never holds the information needed
 * to compute it.
 */
export async function startMasteryCheck(
  app: FastifyInstance,
  userId: string,
  nodeId: string,
): Promise<StartMasteryResponse> {
  const node = await app.prisma.curriculumNode.findUnique({ where: { id: nodeId } });
  if (!node) throw new NodeNotFoundError(`CurriculumNode ${nodeId} not found`);

  // No prerequisite gate here — see lesson.service.ts's matching comment.

  const user = await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });

  // Retrieval is filtered on the NODE's own coordinates, not the user's class —
  // a student may legitimately revisit a lower class's level, and the questions
  // must come from that level's chapter either way (CLAUDE.md RAG guardrail).
  const queryEmbedding = await embedText(`${node.title}. ${node.description}`);
  const matches = await searchDocumentChunks(app, {
    classLevel: node.classLevel,
    subject: node.subject,
    chapter: node.chapterNumber,
    queryEmbedding,
    limit: RETRIEVAL_LIMIT,
  });

  if (matches.length === 0) {
    app.log.warn(
      { nodeId, classLevel: node.classLevel, subject: node.subject, chapter: node.chapterNumber },
      "Mastery check generated with no retrieved textbook context — chapter may not be ingested",
    );
  }

  const questions = await generateQuestions(app, {
    nodeTitle: node.title,
    nodeDescription: node.description,
    subject: node.subject,
    classLevel: user.classLevel,
    chapter: node.chapterNumber,
    contextChunks: matches.map((m) => ({ content: m.content, page: pageOf(m.metadata) })),
  });

  const attempt = await app.prisma.masteryAttempt.create({
    data: {
      userId,
      nodeId,
      questions: questions as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    attemptId: attempt.id,
    nodeId,
    nodeTitle: node.title,
    questions: questions.map(toClientQuestion),
    passThreshold: PASS_THRESHOLD,
  };
}

/**
 * Grades a submitted attempt entirely from the persisted answer key.
 *
 * On a pass this calls completeNode() with the computed score — which is the
 * only path that writes UserProgress.score now that the client can no longer
 * supply one.
 */
export async function submitMasteryCheck(
  app: FastifyInstance,
  userId: string,
  attemptId: string,
  answers: SubmittedAnswer[],
): Promise<SubmitMasteryResponse> {
  const attempt = await app.prisma.masteryAttempt.findUnique({ where: { id: attemptId } });
  // Same error for "doesn't exist" and "belongs to someone else" — don't leak
  // the existence of another student's attempt.
  if (!attempt || attempt.userId !== userId) {
    throw new AttemptNotFoundError(`MasteryAttempt ${attemptId} not found`);
  }
  if (attempt.submittedAt) {
    throw new AttemptAlreadySubmittedError(`MasteryAttempt ${attemptId} has already been submitted`);
  }

  const questions = attempt.questions as unknown as StoredMasteryQuestion[];
  const selectedByQuestion = new Map(answers.map((a) => [a.questionId, a.selectedIndex]));

  const results: MasteryQuestionResult[] = questions.map((q) => {
    // An unanswered or unknown question id counts as wrong, never as correct.
    const selected = selectedByQuestion.get(q.id);
    const selectedIndex = typeof selected === "number" ? selected : null;
    return {
      questionId: q.id,
      prompt: q.prompt,
      options: q.options,
      selectedIndex,
      correctIndex: q.correctIndex,
      correct: selectedIndex === q.correctIndex,
      explanation: q.explanation,
      sourcePage: q.sourcePage,
    };
  });

  const correctCount = results.filter((r) => r.correct).length;
  const score = Math.round((correctCount / questions.length) * 100);
  const passed = score >= PASS_THRESHOLD;

  // Gathered before this attempt's own row is updated, so "prior failed
  // attempt" and "nodes completed so far" both reflect the state going
  // into this submission — what the badge rules in badges.service.ts
  // actually mean by "before."
  const [node, hadPriorFailedAttempt, completedNodeCountBefore] = await Promise.all([
    app.prisma.curriculumNode.findUniqueOrThrow({ where: { id: attempt.nodeId } }),
    app.prisma.masteryAttempt.count({ where: { userId, nodeId: attempt.nodeId, passed: false } }).then((c) => c > 0),
    app.prisma.userProgress.count({ where: { userId, status: "COMPLETED" } }),
  ]);

  await app.prisma.masteryAttempt.update({
    where: { id: attemptId },
    data: {
      answers: answers as unknown as Prisma.InputJsonValue,
      score,
      passed,
      submittedAt: new Date(),
    },
  });

  // Retries are allowed and the best score is kept: completeNode() already
  // treats a re-completion as 0 XP, and we only overwrite the stored score
  // when this attempt beat the previous one.
  let progress = null;
  if (passed) {
    const existing = await app.prisma.userProgress.findUnique({
      where: { userId_nodeId: { userId, nodeId: attempt.nodeId } },
    });
    const bestScore = Math.max(score, existing?.score ?? 0);
    progress = await completeNode(app, userId, attempt.nodeId, bestScore);

    // PLAN.md Phase 3 §3.2 — "consider scaling XP by mastery score and
    // first-attempt bonus." Went with a flat first-attempt bonus only,
    // not continuous score-scaling: a formula tying XP to score needs a
    // product decision on the curve (linear? threshold bands?) this plan
    // doesn't specify, so it's not guessed at here. First-attempt is
    // unambiguous — completeNode() already returns 0 XP on every attempt
    // after the first real award, so this only ever fires once per node.
    if (progress.xpAwarded > 0 && !hadPriorFailedAttempt) {
      const bonus = Math.round(progress.xpAwarded * FIRST_ATTEMPT_XP_BONUS_RATE);
      const bonusedUser = await app.prisma.user.update({ where: { id: userId }, data: { xp: { increment: bonus } } });
      progress = { ...progress, xpAwarded: progress.xpAwarded + bonus, totalXp: bonusedUser.xp };
    }
  }

  // PLAN.md Phase 3 §3.3 — a graded score is a real mastery signal; feed it
  // into the profile the Orchestrator reads, not just the chat-keyword guess.
  await applyMasteryResultToProfile(app, {
    userId,
    subject: node.subject,
    chapter: node.chapterNumber,
    score,
  }).catch((err) => app.log.error(err, "Failed to apply mastery result to profile"));

  // Fire-and-forget, same rationale as the chat evaluator: a badge-award
  // failure should never turn a successful mastery submission into an error.
  let newBadges: BadgeAward[] = [];
  if (passed) {
    try {
      newBadges = await evaluateMasteryBadges(app, {
        userId,
        score,
        passed,
        hadPriorFailedAttempt,
        completedNodeCountBefore,
      });
      const chapterBadge = await evaluateChapterClearedBadge(app, userId, node);
      if (chapterBadge) newBadges.push(chapterBadge);
      await recordActivity(app, userId);
      const updatedUser = await app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { streakDays: true } });
      newBadges = [...newBadges, ...(await evaluateStreakBadges(app, userId, updatedUser.streakDays))];
    } catch (err) {
      app.log.error(err, "Failed to evaluate badges/streak after mastery submission");
    }
  }

  return {
    attemptId,
    nodeId: attempt.nodeId,
    score,
    passed,
    passThreshold: PASS_THRESHOLD,
    correctCount,
    totalQuestions: questions.length,
    results,
    progress,
    newBadges: newBadges.map((b) => ({
      key: b.key,
      title: b.definition.title,
      description: b.definition.description,
      icon: b.definition.icon,
    })),
  };
}
