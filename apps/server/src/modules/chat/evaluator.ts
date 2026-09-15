import type { FastifyInstance } from "fastify";
import type { Prisma } from "@shikkha-ai/database";
import type { ResponseType } from "./orchestrator";

/**
 * The Background Learning Evaluator (PLAN.md Phase 8 §3): a fire-and-forget
 * pass run after every chat turn that reads the student's own message for
 * cheap, zero-cost signals and nudges their UserProfile accordingly.
 *
 * Deliberately heuristic (regex/keyword), not an LLM call — the project has
 * spent much of its build fighting a 20-requests/day free-tier Gemini quota,
 * so a second model call per chat turn just to score sentiment would burn
 * that budget twice as fast for a soft signal. Easy to upgrade later: swap
 * `detectSignals` for a structured-output classification call and keep
 * everything downstream (the profile update, weakTopics refresh) unchanged.
 */

const EMA_RATE = 0.15;
const NUDGE = 0.1; // smaller, deliberate step for the keyword-triggered nudges below
const WEAK_TOPICS_LIMIT = 3;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function ema(current: number, target: number, rate: number): number {
  return Math.round((current * (1 - rate) + target * rate) * 100) / 100;
}

// An array of small patterns, not one mega-alternation — easier to reason about, and avoids a
// real bug that mega-alternation had: `\b` right after an optional trailing "?" doesn't match at
// end-of-string/before-a-space the way it looks like it should (a "?" is a non-word char, so the
// boundary assertion after it needs a word char next, which "again?" at the end of a message never has).
const CONFUSION_PATTERNS = [
  /\b(don'?t|do ?not|didn'?t|can'?t|couldn'?t)\s+(get|understand)\b/i,
  /\bconfus(ed|ing)\b/i,
  /\bmakes? no sense\b/i,
  /\bnot clear\b/i,
  /\bagain\b/i,
  /\beita bujhi ?nai\b/i,
  /\bbujhtesi ?na\b/i,
];
const TOO_LONG_PATTERN = /\b(too long|shorter|tl;?dr|just tell me|too much|briefly|in short)\b/i;
const VISUAL_REQUEST_PATTERN = /\b(show me|diagram|picture|draw it|animation|visuali[sz]e)\b/i;
const VIDEO_REQUEST_PATTERN = /\b(video|watch)\b/i;
const MATH_REQUEST_PATTERN = /\b(prove it|step by step|derivation|formula|show (the )?math|equation)\b/i;
const COMPREHENSION_CONFIRM_PATTERN = /\b(got it|makes sense|that helped|easy|i understand|thanks?,? (that|this) helped)\b/i;
const BANGLA_UNICODE_PATTERN = /[ঀ-৿]/;
const BANGLISH_TOKEN_PATTERN = /\b(ki|kemon|bhalo|ache|nai|tumi|ami|amar|bujhi|bujhtesi|kotha)\b/i;

interface DetectedSignals {
  patienceDelta: number;
  visualDelta: number;
  mathDelta: number;
  comprehension: "HIGH" | "LOW" | null;
  languageMix: "BANGLA" | "BANGLISH" | "ENGLISH" | null;
}

/** Cheap keyword/regex pass over the student's own message — see the module docstring for why this isn't an LLM call. */
function detectSignals(message: string): DetectedSignals {
  let patienceDelta = 0;
  let visualDelta = 0;
  let mathDelta = 0;
  let comprehension: DetectedSignals["comprehension"] = null;

  if (CONFUSION_PATTERNS.some((pattern) => pattern.test(message))) {
    patienceDelta -= NUDGE;
    comprehension = "LOW";
  }
  if (TOO_LONG_PATTERN.test(message)) {
    patienceDelta -= NUDGE;
  }
  if (VISUAL_REQUEST_PATTERN.test(message) || VIDEO_REQUEST_PATTERN.test(message)) {
    visualDelta += NUDGE;
  }
  if (MATH_REQUEST_PATTERN.test(message)) {
    mathDelta += NUDGE;
  }
  if (COMPREHENSION_CONFIRM_PATTERN.test(message)) {
    patienceDelta += NUDGE / 2;
    comprehension = "HIGH";
  }

  let languageMix: DetectedSignals["languageMix"] = null;
  if (BANGLA_UNICODE_PATTERN.test(message)) {
    languageMix = "BANGLA";
  } else if (BANGLISH_TOKEN_PATTERN.test(message)) {
    languageMix = "BANGLISH";
  }
  // A message with no Bangla/Banglish markers is left as a null signal (not forced to "ENGLISH")
  // so one neutral "ok" doesn't flip a Bangla-speaking student's languageMix back and forth.

  return { patienceDelta, visualDelta, mathDelta, comprehension, languageMix };
}

/** This user's own weakest topics (by avg UserProgress score) — refreshed here so the Orchestrator can just read the cached UserProfile.weakTopics field. */
async function computeWeakTopics(app: FastifyInstance, userId: string): Promise<string[]> {
  const groups = await app.prisma.userProgress.groupBy({
    by: ["nodeId"],
    where: { userId },
    _avg: { score: true },
    orderBy: { _avg: { score: "asc" } },
    take: WEAK_TOPICS_LIMIT,
  });
  if (groups.length === 0) return [];

  const nodes = await app.prisma.curriculumNode.findMany({
    where: { id: { in: groups.map((g) => g.nodeId) } },
  });
  const titleById = new Map(nodes.map((n) => [n.id, n.title]));
  return groups.map((g) => titleById.get(g.nodeId)).filter((t): t is string => Boolean(t));
}

export interface EvaluatorParams {
  userId: string;
  message: string;
  subject: string;
  chapter: number;
  responseType: ResponseType;
}

/**
 * Runs fire-and-forget after every chat turn. Never throws into the caller —
 * a profile-update failure should never surface as a chat error, so callers
 * should `.catch()` this the same way the old learning-profile.service.ts
 * nudge was invoked.
 */
export async function evaluateAndAdaptProfile(app: FastifyInstance, params: EvaluatorParams): Promise<void> {
  const { userId, message, subject, chapter, responseType } = params;

  const [profile, weakTopics] = await Promise.all([
    app.prisma.userProfile.upsert({ where: { userId }, create: { userId }, update: {} }),
    computeWeakTopics(app, userId),
  ]);

  const signals = detectSignals(message);

  // visualPreferenceScore: the responseType-based EMA nudge (carried over from Phase 7's
  // learning-profile.service.ts) plus a direct bump when the student explicitly asked for one.
  const visualTarget = responseType === "TEXT" ? 0 : 1;
  const visualPreferenceScore = clamp01(
    ema(profile.visualPreferenceScore, visualTarget, EMA_RATE) + signals.visualDelta,
  );
  const patienceLevel = clamp01(profile.patienceLevel + signals.patienceDelta);
  const mathRigidityScore = clamp01(profile.mathRigidityScore + signals.mathDelta);
  const languageMix = signals.languageMix ?? profile.languageMix;

  const topicKey = `${subject}:ch${chapter}`;
  const masteryMatrix =
    signals.comprehension !== null
      ? { ...(profile.masteryMatrix as Record<string, string>), [topicKey]: signals.comprehension }
      : (profile.masteryMatrix as Record<string, string>);

  await app.prisma.userProfile.update({
    where: { userId },
    data: {
      visualPreferenceScore,
      patienceLevel,
      mathRigidityScore,
      languageMix,
      masteryMatrix: masteryMatrix as unknown as Prisma.InputJsonObject,
      weakTopics,
    },
  });
}

function scoreToComprehensionBucket(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 80) return "HIGH";
  if (score >= 50) return "MEDIUM";
  return "LOW";
}

/**
 * PLAN.md Phase 3 §3.3: "feed mastery results into masteryMatrix" — until
 * now the field was set only from `detectSignals`'s chat-keyword guess
 * ("got it" / "confusing"), never from an actual graded score, despite the
 * field name. Called by mastery.service.ts right after grading, using the
 * exact same `topicKey` convention as the chat-turn evaluator above so a
 * later chat turn on the same chapter sees one coherent value, not two
 * competing writers fighting over the same key.
 */
export async function applyMasteryResultToProfile(
  app: FastifyInstance,
  params: { userId: string; subject: string; chapter: number; score: number },
): Promise<void> {
  const profile = await app.prisma.userProfile.upsert({
    where: { userId: params.userId },
    create: { userId: params.userId },
    update: {},
  });

  const topicKey = `${params.subject}:ch${params.chapter}`;
  const masteryMatrix = {
    ...(profile.masteryMatrix as Record<string, string>),
    [topicKey]: scoreToComprehensionBucket(params.score),
  };

  await app.prisma.userProfile.update({
    where: { userId: params.userId },
    data: { masteryMatrix: masteryMatrix as unknown as Prisma.InputJsonObject },
  });
}
