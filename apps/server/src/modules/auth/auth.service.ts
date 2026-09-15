import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
import type { Role } from "@shikkha-ai/database";
import { env } from "../../config/env";
import type { AccessTokenPayload } from "../../types/fastify";
import type { AuthUserView } from "./auth.schema";

const SALT_ROUNDS = 12;
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REFRESH_TOKEN_TTL_JWT = "7d";

export const REFRESH_COOKIE_NAME = "shikkha_refresh_token";

export const refreshCookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  secure: env.NODE_ENV === "production",
  // Path "/" (not "/api/v1/auth") so the browser still attaches it on plain
  // page navigations (e.g. GET /roadmap) — Next.js Middleware needs to see
  // it there to gate routes. It's HttpOnly, so no other JS can read it; the
  // only route that ever reads its value is /auth/refresh.
  path: "/",
  maxAge: REFRESH_TOKEN_TTL_MS / 1000,
};

/**
 * NOT a security boundary — readable by frontend JS/Middleware so Next.js can
 * redirect based on role without duplicating JWT_REFRESH_SECRET into the
 * frontend. The backend's requireAdmin preHandler is what actually enforces
 * admin-only routes; a forged/stale value here only affects UX redirects.
 */
export const ROLE_COOKIE_NAME = "shikkha_role";

export const roleCookieOptions = {
  httpOnly: false,
  sameSite: "strict" as const,
  secure: env.NODE_ENV === "production",
  path: "/",
  maxAge: REFRESH_TOKEN_TTL_MS / 1000,
};

interface RefreshTokenPayload {
  userId: string;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

/** False (not a throw) for an OAuth-only user with no passwordHash — they simply can't password-login. */
export async function verifyPassword(password: string, passwordHash: string | null): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }
  return bcrypt.compare(password, passwordHash);
}

export function toAuthUserView(user: {
  id: string;
  email: string;
  name: string;
  role: Role;
  classLevel: number;
  xp: number;
  streakDays: number;
  emailVerified: boolean;
  avatarUrl: string | null;
}): AuthUserView {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    classLevel: user.classLevel,
    xp: user.xp,
    streakDays: user.streakDays,
    emailVerified: user.emailVerified,
    avatarUrl: user.avatarUrl,
  };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function signAccessToken(app: FastifyInstance, payload: AccessTokenPayload): string {
  return app.jwt.sign(payload);
}

function signRefreshToken(userId: string): string {
  const payload: RefreshTokenPayload = { userId };
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: REFRESH_TOKEN_TTL_JWT });
}

export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshTokenPayload;
}

/**
 * Issues a fresh access/refresh token pair for a user and persists the
 * hashed refresh token so it can be validated and revoked later.
 */
export async function issueTokenPair(
  app: FastifyInstance,
  user: { id: string; role: Role; classLevel: number; emailVerified: boolean },
): Promise<{ accessToken: string; refreshToken: string }> {
  const accessToken = signAccessToken(app, {
    userId: user.id,
    role: user.role,
    classLevel: user.classLevel,
    emailVerified: user.emailVerified,
  });
  const refreshToken = signRefreshToken(user.id);

  await app.prisma.refreshToken.create({
    data: {
      tokenHash: hashToken(refreshToken),
      userId: user.id,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    },
  });

  return { accessToken, refreshToken };
}

export async function revokeAllUserRefreshTokens(app: FastifyInstance, userId: string): Promise<void> {
  await app.prisma.refreshToken.updateMany({
    where: { userId, revoked: false },
    data: { revoked: true },
  });
}

/**
 * Validates a raw refresh token against the DB (must exist, be unrevoked,
 * unexpired), then revokes it. Returns the associated userId, or null if
 * the token is invalid/reused.
 */
export async function consumeRefreshToken(
  app: FastifyInstance,
  rawToken: string,
): Promise<{ userId: string; role: Role; classLevel: number } | null> {
  let payload: RefreshTokenPayload;
  try {
    payload = verifyRefreshToken(rawToken);
  } catch {
    return null;
  }

  const tokenHash = hashToken(rawToken);
  const stored = await app.prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!stored || stored.revoked || stored.expiresAt < new Date() || stored.userId !== payload.userId) {
    return null;
  }

  await app.prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revoked: true },
  });

  return { userId: stored.user.id, role: stored.user.role, classLevel: stored.user.classLevel };
}

export async function revokeRefreshToken(app: FastifyInstance, rawToken: string): Promise<void> {
  const tokenHash = hashToken(rawToken);
  await app.prisma.refreshToken.updateMany({
    where: { tokenHash },
    data: { revoked: true },
  });
}
