import type { FastifyInstance } from "fastify";

/**
 * Phase 3 gamification. The catalog lives here, in code — not a `Badge` DB
 * table (see schema.prisma's comment on `UserBadge`) — because nothing
 * admin-editable exists for it yet; adding a new badge is adding a key
 * here, not a migration.
 *
 * **Open question resolved as-built:** the original plan asked "synchronous
 * in completeNode(), or a separate evaluator pass?" — went synchronous,
 * called right after each mastery submission and lesson kickoff (see call
 * sites in mastery.service.ts / progress.service.ts). Simpler and
 * transactional-adjacent; retroactive awards for a *newly added* badge
 * would need a one-off backfill script, not built here.
 */
export interface BadgeDefinition {
  key: string;
  title: string;
  description: string;
  icon: string; // a single emoji
}

export const BADGE_DEFINITIONS: Record<string, BadgeDefinition> = {
  FIRST_STEPS: {
    key: "FIRST_STEPS",
    title: "First Steps",
    description: "Completed your first level.",
    icon: "🎉",
  },
  PERFECT_SCORE: {
    key: "PERFECT_SCORE",
    title: "Perfect Score",
    description: "Passed a Mastery Check with 100%.",
    icon: "💯",
  },
  COMEBACK: {
    key: "COMEBACK",
    title: "Comeback",
    description: "Passed a Mastery Check after failing it at least once.",
    icon: "💪",
  },
  STREAK_3: {
    key: "STREAK_3",
    title: "3-Day Streak",
    description: "Studied three days in a row.",
    icon: "🔥",
  },
  STREAK_7: {
    key: "STREAK_7",
    title: "7-Day Streak",
    description: "Studied seven days in a row.",
    icon: "🔥",
  },
};

/** Prefix for the one dynamically-keyed badge family — see chapterClearedDefinition(). */
const CHAPTER_CLEARED_PREFIX = "CHAPTER_CLEARED:";

/**
 * "Chapter cleared" isn't one badge, it's one per (subject, chapter) — so
 * unlike everything in BADGE_DEFINITIONS above, its key and metadata are
 * both built at award time rather than looked up from a fixed catalog
 * entry. The key format (`CHAPTER_CLEARED:<subject>:<chapter>`) is parsed
 * back out in listEarnedBadges() to reconstruct the same definition for display.
 */
function chapterClearedDefinition(subject: string, chapterNumber: number): BadgeDefinition {
  return {
    key: `${CHAPTER_CLEARED_PREFIX}${subject}:${chapterNumber}`,
    title: `${subject} · Chapter ${chapterNumber} Cleared`,
    description: `Completed every level in ${subject} Chapter ${chapterNumber}.`,
    icon: "📘",
  };
}

export interface BadgeAward {
  key: string;
  definition: BadgeDefinition;
}

async function award(app: FastifyInstance, userId: string, definition: BadgeDefinition): Promise<BadgeAward | null> {
  try {
    await app.prisma.userBadge.create({ data: { userId, badgeKey: definition.key } });
    return { key: definition.key, definition };
  } catch {
    // Unique constraint on (userId, badgeKey) — already earned. Not an error.
    return null;
  }
}

/**
 * Called after a Mastery Check is graded (mastery.service.ts). Evaluates
 * every rule that depends on mastery outcomes; returns the badges newly
 * earned by *this* submission (for a "you earned a badge!" toast — never
 * required, just nicer than silence).
 */
export async function evaluateMasteryBadges(
  app: FastifyInstance,
  params: { userId: string; score: number; passed: boolean; hadPriorFailedAttempt: boolean; completedNodeCountBefore: number },
): Promise<BadgeAward[]> {
  if (!params.passed) return [];

  const awards: BadgeAward[] = [];

  if (params.completedNodeCountBefore === 0) {
    const a = await award(app, params.userId, BADGE_DEFINITIONS.FIRST_STEPS!);
    if (a) awards.push(a);
  }
  if (params.score === 100) {
    const a = await award(app, params.userId, BADGE_DEFINITIONS.PERFECT_SCORE!);
    if (a) awards.push(a);
  }
  if (params.hadPriorFailedAttempt) {
    const a = await award(app, params.userId, BADGE_DEFINITIONS.COMEBACK!);
    if (a) awards.push(a);
  }

  return awards;
}

/**
 * Called after a Mastery Check pass completes a node (mastery.service.ts,
 * after completeNode()) — checks whether every node in that node's own
 * chapter is now COMPLETED for this user, and awards the chapter's badge
 * if so. A no-op (not an error) for a chapter with only one level, in
 * which case this fires alongside FIRST_STEPS/whatever else — both are
 * legitimately earned by the same submission.
 */
export async function evaluateChapterClearedBadge(
  app: FastifyInstance,
  userId: string,
  node: { classLevel: number; subject: string; chapterNumber: number },
): Promise<BadgeAward | null> {
  const chapterNodes = await app.prisma.curriculumNode.findMany({
    where: { classLevel: node.classLevel, subject: node.subject, chapterNumber: node.chapterNumber },
    select: { id: true },
  });
  if (chapterNodes.length === 0) return null;

  const completedCount = await app.prisma.userProgress.count({
    where: { userId, status: "COMPLETED", nodeId: { in: chapterNodes.map((n) => n.id) } },
  });
  if (completedCount < chapterNodes.length) return null;

  return award(app, userId, chapterClearedDefinition(node.subject, node.chapterNumber));
}

/** Called after recordActivity (lib/streak.ts) updates streakDays. */
export async function evaluateStreakBadges(app: FastifyInstance, userId: string, streakDays: number): Promise<BadgeAward[]> {
  const awards: BadgeAward[] = [];
  if (streakDays >= 3) {
    const a = await award(app, userId, BADGE_DEFINITIONS.STREAK_3!);
    if (a) awards.push(a);
  }
  if (streakDays >= 7) {
    const a = await award(app, userId, BADGE_DEFINITIONS.STREAK_7!);
    if (a) awards.push(a);
  }
  return awards;
}

export interface EarnedBadgeView {
  key: string;
  title: string;
  description: string;
  icon: string;
  earnedAt: Date;
}

function definitionForKey(key: string): BadgeDefinition | null {
  if (key.startsWith(CHAPTER_CLEARED_PREFIX)) {
    const rest = key.slice(CHAPTER_CLEARED_PREFIX.length);
    const lastColon = rest.lastIndexOf(":");
    if (lastColon === -1) return null;
    const subject = rest.slice(0, lastColon);
    const chapterNumber = Number(rest.slice(lastColon + 1));
    if (!subject || Number.isNaN(chapterNumber)) return null;
    return chapterClearedDefinition(subject, chapterNumber);
  }
  return BADGE_DEFINITIONS[key] ?? null;
}

export async function listEarnedBadges(app: FastifyInstance, userId: string): Promise<EarnedBadgeView[]> {
  const rows = await app.prisma.userBadge.findMany({ where: { userId }, orderBy: { earnedAt: "desc" } });
  return rows
    .map((r) => {
      const definition = definitionForKey(r.badgeKey);
      return definition ? { ...definition, earnedAt: r.earnedAt } : null;
    })
    .filter((b): b is EarnedBadgeView => b !== null); // tolerate a since-removed/unparseable key rather than crashing
}
