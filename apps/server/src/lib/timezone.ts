/**
 * Shared by lib/streak.ts (day-boundary comparison for streakDays) and
 * profile.service.ts (today's XP against UserSettings.dailyXpGoal) — both
 * need "what calendar day is this timestamp, in this student's own
 * timezone," via Intl.DateTimeFormat rather than a date library.
 */
export function dateKeyInTimezone(date: Date, timezone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD, which sorts/compares correctly as a plain string.
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    // An invalid/unsupported IANA name (e.g. a hand-typed settings value) falls back to UTC rather than throwing.
    return new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }
}
