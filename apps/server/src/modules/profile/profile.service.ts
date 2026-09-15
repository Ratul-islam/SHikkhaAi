import type { FastifyInstance } from "fastify";
import type { Role, UserSettings } from "@shikkha-ai/database";
import { generateDefaultAvatar } from "../../lib/avatar";
import { dateKeyInTimezone } from "../../lib/timezone";
import type {
  ClassProgressionRecord,
  ProfileStatsResponse,
  ProfileView,
  Theme,
  UpdateAvatarBody,
  UpdateProfileBody,
  UpdateSettingsBody,
  UserSettingsView,
} from "./profile.schema";

interface UserRecord {
  id: string;
  email: string;
  name: string;
  address: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: Role;
  classLevel: number;
  emailVerified: boolean;
  xp: number;
  streakDays: number;
}

function toSettingsView(settings: UserSettings): UserSettingsView {
  return {
    theme: settings.theme as Theme,
    emailNotifications: settings.emailNotifications,
    dailyXpGoal: settings.dailyXpGoal,
    preferredSubject: settings.preferredSubject,
    timezone: settings.timezone,
    reducedMotion: settings.reducedMotion,
  };
}

/** Same lazy-create pattern as UserProfile (orchestrator.ts's getOrCreateUserProfile) — a settings row missing (e.g. a pre-Phase-3 account) should never 500 a request, just take the defaults. */
async function getOrCreateSettings(app: FastifyInstance, userId: string): Promise<UserSettings> {
  return app.prisma.userSettings.upsert({ where: { userId }, create: { userId }, update: {} });
}

export function toProfileView(user: UserRecord, settings: UserSettings): ProfileView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    address: user.address,
    phone: user.phone,
    avatarUrl: user.avatarUrl,
    role: user.role,
    classLevel: user.classLevel,
    emailVerified: user.emailVerified,
    xp: user.xp,
    streakDays: user.streakDays,
    settings: toSettingsView(settings),
  };
}

export async function getProfile(app: FastifyInstance, userId: string): Promise<ProfileView> {
  const [user, settings] = await Promise.all([
    app.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    getOrCreateSettings(app, userId),
  ]);
  return toProfileView(user, settings);
}

/** Name/address/phone only — never classLevel (see updateClassLevel: it's a bigger decision, kept as its own route). */
export async function updateProfile(
  app: FastifyInstance,
  userId: string,
  body: UpdateProfileBody,
): Promise<ProfileView> {
  const [user, settings] = await Promise.all([
    app.prisma.user.update({
      where: { id: userId },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.address !== undefined ? { address: body.address } : {}),
        ...(body.phone !== undefined ? { phone: body.phone } : {}),
      },
    }),
    getOrCreateSettings(app, userId),
  ]);
  return toProfileView(user, settings);
}

/**
 * Switching classLevel is deliberately a no-op on existing data: UserProgress
 * rows are keyed by nodeId, not classLevel, so progress made in a previous
 * class simply becomes invisible until the student switches back — nothing
 * is deleted, no migration needed. See PLAN.md Phase 5 §5.4 for the
 * alternative (blocking the switch) that was considered and not chosen.
 */
export async function updateClassLevel(
  app: FastifyInstance,
  userId: string,
  classLevel: number,
): Promise<ProfileView> {
  const [user, settings] = await Promise.all([
    app.prisma.user.update({ where: { id: userId }, data: { classLevel } }),
    getOrCreateSettings(app, userId),
  ]);
  return toProfileView(user, settings);
}

/** PATCH /profile/settings — only the fields present in body are touched, same convention as updateProfile. */
export async function updateSettings(
  app: FastifyInstance,
  userId: string,
  body: UpdateSettingsBody,
): Promise<ProfileView> {
  await app.prisma.userSettings.upsert({
    where: { userId },
    create: { userId, ...body },
    update: { ...body },
  });
  return getProfile(app, userId);
}

export class InvalidAvatarError extends Error {}

/**
 * Exactly one of `regenerate` (a fresh deterministic look, reseeded off a
 * random value so it actually changes) or `avatarUrl` (the student pastes
 * their own image URL) — profile.schema.ts's `maxProperties: 1` already
 * enforces "exactly one" at the validation layer, this just acts on
 * whichever was sent.
 */
export async function updateAvatar(app: FastifyInstance, userId: string, body: UpdateAvatarBody): Promise<ProfileView> {
  const user = await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const avatarUrl = body.regenerate
    ? generateDefaultAvatar(`${userId}:${Date.now()}`, user.name)
    : body.avatarUrl;

  if (!avatarUrl) {
    throw new InvalidAvatarError("Either regenerate or avatarUrl must be provided");
  }

  const [updatedUser, settings] = await Promise.all([
    app.prisma.user.update({ where: { id: userId }, data: { avatarUrl } }),
    getOrCreateSettings(app, userId),
  ]);
  return toProfileView(updatedUser, settings);
}

/**
 * Backs the "per-class progression records" + statistics the user asked
 * for. Computed per class level 1-12 by joining UserProgress → CurriculumNode
 * (UserProgress itself doesn't carry classLevel) — one query per class
 * rather than N+1 per node, since 12 is a small fixed fan-out.
 */
export async function getStats(app: FastifyInstance, userId: string): Promise<ProfileStatsResponse> {
  const [user, settings, masteryAttempts, allProgress] = await Promise.all([
    app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { xp: true, streakDays: true } }),
    getOrCreateSettings(app, userId),
    app.prisma.masteryAttempt.findMany({
      where: { userId, submittedAt: { not: null } },
      select: { passed: true },
    }),
    app.prisma.userProgress.findMany({
      where: { userId, status: "COMPLETED" },
      select: { score: true, completedAt: true, node: { select: { classLevel: true, totalXp: true } } },
    }),
  ]);

  const masteryAttemptsCount = masteryAttempts.length;
  const masteryPassRate =
    masteryAttemptsCount > 0
      ? Math.round((masteryAttempts.filter((a) => a.passed).length / masteryAttemptsCount) * 100)
      : null;

  // XP earned "today," against UserSettings.dailyXpGoal — derived from
  // UserProgress.completedAt rather than a dedicated XP ledger (none
  // exists). Same known simplification as perClass[].xpEarned below: the
  // first-attempt bonus (mastery.service.ts) isn't attributed to any one
  // node/day, so this undercounts a day that included a bonus by that
  // bonus's amount. Cosmetic, not worth a ledger table for.
  const todayKey = dateKeyInTimezone(new Date(), settings.timezone);
  const todayXp = allProgress
    .filter((p) => p.completedAt && dateKeyInTimezone(p.completedAt, settings.timezone) === todayKey)
    .reduce((sum, p) => sum + p.node.totalXp, 0);

  // Total curriculum size per class — the denominator for "X of Y nodes completed."
  const nodeCountsByClass = await app.prisma.curriculumNode.groupBy({
    by: ["classLevel"],
    _count: { _all: true },
  });
  const totalNodesByClass = new Map(nodeCountsByClass.map((g) => [g.classLevel, g._count._all]));

  const byClass = new Map<number, { completed: number; scoreSum: number; xp: number }>();
  for (const p of allProgress) {
    const entry = byClass.get(p.node.classLevel) ?? { completed: 0, scoreSum: 0, xp: 0 };
    entry.completed += 1;
    entry.scoreSum += p.score;
    entry.xp += p.node.totalXp;
    byClass.set(p.node.classLevel, entry);
  }

  const perClass: ClassProgressionRecord[] = [];
  for (let classLevel = 1; classLevel <= 12; classLevel++) {
    const totalNodes = totalNodesByClass.get(classLevel) ?? 0;
    const entry = byClass.get(classLevel);
    // Skip a class with neither curriculum content nor any progress —
    // nothing meaningful to show, and this app spans 12 classes' worth of
    // rows that mostly won't apply to any one student.
    if (totalNodes === 0 && !entry) continue;
    perClass.push({
      classLevel,
      totalNodes,
      completedNodes: entry?.completed ?? 0,
      averageScore: entry && entry.completed > 0 ? Math.round(entry.scoreSum / entry.completed) : null,
      xpEarned: entry?.xp ?? 0,
    });
  }

  return {
    totalXp: user.xp,
    streakDays: user.streakDays,
    masteryAttemptsCount,
    masteryPassRate,
    completedNodesCount: allProgress.length,
    dailyXpGoal: settings.dailyXpGoal,
    todayXp,
    perClass,
  };
}
