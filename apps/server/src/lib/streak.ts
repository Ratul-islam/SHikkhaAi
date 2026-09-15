import type { FastifyInstance } from "fastify";
import { dateKeyInTimezone } from "./timezone";

/**
 * Closes PLAN.md's `[GAP-4]`: `streakDays` was declared, returned, and
 * animated in `Header.tsx` but nothing ever wrote it — permanently 0.
 *
 * Day boundaries use the student's own `UserSettings.timezone` (via
 * `Intl.DateTimeFormat`, no extra date library needed) rather than server
 * UTC — a student studying at 11pm Dhaka time shouldn't have their streak
 * silently computed against a UTC day that already rolled over.
 */

export const DEFAULT_TIMEZONE = "Asia/Dhaka";

/**
 * Called once per meaningful activity (a chat turn, a lesson kickoff, a
 * mastery submission — see call sites). Idempotent within a day: calling it
 * five times in one day only counts once, since the comparison is against
 * the *previous* `lastActiveAt`, not a counter.
 */
export async function recordActivity(app: FastifyInstance, userId: string): Promise<void> {
  const [user, settings] = await Promise.all([
    app.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { streakDays: true, lastActiveAt: true } }),
    app.prisma.userSettings.findUnique({ where: { userId }, select: { timezone: true } }),
  ]);

  const timezone = settings?.timezone ?? DEFAULT_TIMEZONE;
  const now = new Date();
  const todayKey = dateKeyInTimezone(now, timezone);
  const lastKey = dateKeyInTimezone(user.lastActiveAt, timezone);

  // Same day as the last recorded activity AND a streak already in
  // progress — already counted today, nothing to change. The `streakDays
  // === 0` carve-out matters for a brand-new account: `lastActiveAt` is set
  // at row creation (today), so without this a student's very first
  // activity would otherwise fall into this branch and never actually
  // start the streak at 1 until a second, different day showed up.
  if (todayKey === lastKey && user.streakDays > 0) {
    // Still touch lastActiveAt (via @updatedAt) so it stays a genuine "last
    // seen" signal for analytics, without recomputing the streak itself.
    await app.prisma.user.update({ where: { id: userId }, data: { streakDays: user.streakDays } });
    return;
  }

  const yesterdayKey = dateKeyInTimezone(new Date(now.getTime() - 24 * 60 * 60 * 1000), timezone);
  const nextStreak = todayKey === lastKey || lastKey === yesterdayKey ? user.streakDays + 1 : 1;

  await app.prisma.user.update({ where: { id: userId }, data: { streakDays: nextStreak } });
}
