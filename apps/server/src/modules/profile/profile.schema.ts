export type Theme = "LIGHT" | "DARK" | "SYSTEM";

export interface UserSettingsView {
  theme: Theme;
  emailNotifications: boolean;
  dailyXpGoal: number;
  preferredSubject: string | null;
  timezone: string;
  reducedMotion: boolean;
}

export interface ProfileView {
  id: string;
  email: string;
  name: string;
  address: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: "STUDENT" | "ADMIN";
  classLevel: number;
  emailVerified: boolean;
  xp: number;
  streakDays: number;
  settings: UserSettingsView;
}

export interface UpdateProfileBody {
  name?: string;
  address?: string | null;
  phone?: string | null;
}

export interface UpdateClassBody {
  classLevel: number;
}

/** All optional — PATCH /profile/settings only touches the fields it's given, same convention as UpdateProfileBody. */
export interface UpdateSettingsBody {
  theme?: Theme;
  emailNotifications?: boolean;
  dailyXpGoal?: number;
  preferredSubject?: string | null;
  timezone?: string;
  reducedMotion?: boolean;
}

/** Exactly one of the two — see profile.service.ts's updateAvatar. */
export interface UpdateAvatarBody {
  regenerate?: true;
  avatarUrl?: string;
}

/** One class level's progression record — "per-class progression records" the user asked for. Only classLevel/Phase 5's changeable-class feature makes this meaningful: progress made in a class stays recorded even after switching away from it. */
export interface ClassProgressionRecord {
  classLevel: number;
  totalNodes: number;
  completedNodes: number;
  averageScore: number | null;
  xpEarned: number;
}

export interface ProfileStatsResponse {
  totalXp: number;
  streakDays: number;
  masteryAttemptsCount: number;
  masteryPassRate: number | null;
  completedNodesCount: number;
  dailyXpGoal: number;
  /** XP earned so far today (student's own timezone) — for the goal meter against dailyXpGoal. */
  todayXp: number;
  perClass: ClassProgressionRecord[];
}

export interface EarnedBadgeView {
  key: string;
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
}

export interface ErrorResponse {
  error: string;
}

// JSON Schemas for Fastify route validation.

export const updateProfileBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string", minLength: 1 },
    address: { type: ["string", "null"] },
    phone: { type: ["string", "null"] },
  },
} as const;

export const updateClassBodySchema = {
  type: "object",
  required: ["classLevel"],
  additionalProperties: false,
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
  },
} as const;

export const updateSettingsBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    theme: { type: "string", enum: ["LIGHT", "DARK", "SYSTEM"] },
    emailNotifications: { type: "boolean" },
    dailyXpGoal: { type: "integer", minimum: 1, maximum: 1000 },
    preferredSubject: { type: ["string", "null"] },
    timezone: { type: "string", minLength: 1, maxLength: 64 },
    reducedMotion: { type: "boolean" },
  },
} as const;

export const updateAvatarBodySchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  maxProperties: 1,
  properties: {
    regenerate: { type: "boolean", enum: [true] },
    // http(s) (a pasted link) or a data: URI (a direct file upload, read
    // client-side via FileReader — see app/settings/page.tsx's
    // AvatarPicker). AJV's built-in "uri" format rejects `data:` URIs (no
    // authority component), so this is a plain pattern instead, capped at
    // ~750KB base64 — generous for a small profile photo, small enough
    // that a browser can read/PATCH it without a real upload endpoint.
    avatarUrl: { type: "string", pattern: "^(https?:|data:image/)", maxLength: 1_000_000 },
  },
} as const;
