import type { FastifyInstance } from "fastify";
import { sendMail } from "../../lib/email";
import { isEmailConfigured } from "../../config/env";
import { listEarnedBadges } from "../badges/badges.service";

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // one week

/**
 * Makes `UserSettings.emailNotifications` actually do something — until
 * this, the toggle was stored and returned by the API but nothing ever
 * sent an email based on it (a real gap, found in the same audit pass that
 * caught the dark-mode toggle doing nothing).
 *
 * No cron dependency: `notificationsScheduler.ts` calls this on an hourly
 * tick, and this function itself decides who's actually due (nobody, most
 * ticks) — see `lastDigestSentAt`'s guard below. Good enough for a weekly
 * cadence; a missed tick just means a digest goes out slightly late, never
 * twice in the same window.
 */
export async function sendWeeklyDigests(app: FastifyInstance): Promise<{ sent: number }> {
  if (!isEmailConfigured()) {
    // Same "log instead of silently dropping" policy as otp.service.ts —
    // but only worth a debug line here, not a warning per user: this runs
    // hourly and SMTP being unset in dev is the common case, not an error.
    app.log.debug("SMTP not configured — skipping weekly digest run");
    return { sent: 0 };
  }

  const cutoff = new Date(Date.now() - DIGEST_INTERVAL_MS);
  const dueUsers = await app.prisma.user.findMany({
    where: {
      role: "STUDENT",
      emailVerified: true,
      settings: { emailNotifications: true },
      OR: [{ lastDigestSentAt: null }, { lastDigestSentAt: { lt: cutoff } }],
    },
    select: { id: true, email: true, name: true, xp: true, streakDays: true },
  });

  let sent = 0;
  for (const user of dueUsers) {
    try {
      await sendDigestToUser(app, user, cutoff);
      sent++;
    } catch (err) {
      // One student's bad email address (or a transient SMTP hiccup)
      // shouldn't stop the rest of the run.
      app.log.error(err, `Failed to send weekly digest to user ${user.id}`);
    }
  }
  return { sent };
}

async function sendDigestToUser(
  app: FastifyInstance,
  user: { id: string; email: string; name: string; xp: number; streakDays: number },
  since: Date,
): Promise<void> {
  const [completedThisWeek, badgesEarned] = await Promise.all([
    app.prisma.userProgress.findMany({
      where: { userId: user.id, status: "COMPLETED", completedAt: { gte: since } },
      select: { node: { select: { title: true, totalXp: true } } },
    }),
    listEarnedBadges(app, user.id).then((badges) => badges.filter((b) => b.earnedAt >= since)),
  ]);

  const xpThisWeek = completedThisWeek.reduce((sum, p) => sum + p.node.totalXp, 0);

  const levelsList =
    completedThisWeek.length > 0
      ? `<ul>${completedThisWeek.map((p) => `<li>${p.node.title}</li>`).join("")}</ul>`
      : "<p>No levels completed this week — your roadmap is waiting whenever you're ready!</p>";

  const badgesList =
    badgesEarned.length > 0
      ? `<p>New badges: ${badgesEarned.map((b) => `${b.icon} ${b.title}`).join(", ")}</p>`
      : "";

  await sendMail({
    to: user.email,
    subject: `Your ShikkhaAI week: +${xpThisWeek} XP`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #0f766e;">Hey ${user.name}, here's your week</h2>
        <p style="font-size: 14px; color: #444;">
          You earned <strong>${xpThisWeek} XP</strong> this week (${user.xp} total) and your streak is at
          <strong>${user.streakDays} day${user.streakDays === 1 ? "" : "s"}</strong>.
        </p>
        <h3 style="font-size: 15px;">Levels completed</h3>
        ${levelsList}
        ${badgesList}
        <p style="font-size: 12px; color: #888; margin-top: 24px;">
          You're getting this because email notifications are on in your ShikkhaAI settings — turn them off any time.
        </p>
      </div>
    `,
  });

  await app.prisma.user.update({ where: { id: user.id }, data: { lastDigestSentAt: new Date() } });
}
