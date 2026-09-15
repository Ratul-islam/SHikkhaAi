export interface RegisterRequestBody {
  email: string;
  password: string;
  name: string;
  classLevel: number;
}

export interface LoginRequestBody {
  email: string;
  password: string;
}

export interface AuthUserView {
  id: string;
  email: string;
  name: string;
  role: "STUDENT" | "ADMIN";
  classLevel: number;
  xp: number;
  streakDays: number;
  emailVerified: boolean;
  /** Phase 3 — always set (a generated default if nothing else). See lib/avatar.ts. */
  avatarUrl: string | null;
}

export interface AuthTokenResponse {
  accessToken: string;
  user: AuthUserView;
}

export interface ErrorResponse {
  error: string;
}

export interface MessageResponse {
  message: string;
}

export interface VerifyEmailRequestBody {
  email: string;
  code: string;
}

export interface ResendVerificationRequestBody {
  email: string;
}

export interface ForgotPasswordRequestBody {
  email: string;
}

export interface ResetPasswordRequestBody {
  email: string;
  code: string;
  newPassword: string;
}

// JSON Schemas for Fastify route validation (kept in sync with the interfaces above).

export const registerBodySchema = {
  type: "object",
  required: ["email", "password", "name", "classLevel"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 8 },
    name: { type: "string", minLength: 1 },
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
  },
} as const;

export const loginBodySchema = {
  type: "object",
  required: ["email", "password"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
    password: { type: "string", minLength: 1 },
  },
} as const;

export const verifyEmailBodySchema = {
  type: "object",
  required: ["email", "code"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
    code: { type: "string", minLength: 6, maxLength: 6 },
  },
} as const;

export const resendVerificationBodySchema = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
  },
} as const;

export const forgotPasswordBodySchema = {
  type: "object",
  required: ["email"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
  },
} as const;

export const resetPasswordBodySchema = {
  type: "object",
  required: ["email", "code", "newPassword"],
  additionalProperties: false,
  properties: {
    email: { type: "string", format: "email" },
    code: { type: "string", minLength: 6, maxLength: 6 },
    newPassword: { type: "string", minLength: 8 },
  },
} as const;
