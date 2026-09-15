import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  loginBodySchema,
  registerBodySchema,
  verifyEmailBodySchema,
  resendVerificationBodySchema,
  forgotPasswordBodySchema,
  resetPasswordBodySchema,
  type AuthTokenResponse,
  type ErrorResponse,
  type LoginRequestBody,
  type RegisterRequestBody,
  type MessageResponse,
  type VerifyEmailRequestBody,
  type ResendVerificationRequestBody,
  type ForgotPasswordRequestBody,
  type ResetPasswordRequestBody,
} from "./auth.schema";
import {
  REFRESH_COOKIE_NAME,
  ROLE_COOKIE_NAME,
  consumeRefreshToken,
  hashPassword,
  issueTokenPair,
  refreshCookieOptions,
  revokeAllUserRefreshTokens,
  revokeRefreshToken,
  roleCookieOptions,
  toAuthUserView,
  verifyPassword,
} from "./auth.service";
import { issueOtp, verifyOtp } from "./otp.service";
import { authenticate } from "./auth.hooks";
import oauthRoutes from "./oauth.routes";
import { generateDefaultAvatar } from "../../lib/avatar";

/** Generic OTP-endpoint rate limit — per-IP+route, tight enough to blunt brute force on a 6-digit code. */
const otpRateLimit = { max: 5, timeWindow: "15 minutes" };

const authRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: RegisterRequestBody; Reply: AuthTokenResponse | ErrorResponse }>(
    "/register",
    { schema: { body: registerBodySchema } },
    async (request: FastifyRequest<{ Body: RegisterRequestBody }>, reply: FastifyReply) => {
      const { email, password, name, classLevel } = request.body;

      const existing = await app.prisma.user.findUnique({ where: { email } });
      if (existing) {
        return reply.code(409).send({ error: "An account with this email already exists" });
      }

      const passwordHash = await hashPassword(password);
      const user = await app.prisma.user.create({
        data: {
          email,
          name,
          passwordHash,
          classLevel,
          // A password signup has no provider photo to borrow (contrast
          // oauth.routes.ts's Google flow) — deterministic generated avatar
          // so the frontend never renders a "no avatar" placeholder state.
          avatarUrl: generateDefaultAvatar(email, name),
          profile: { create: {} }, // all UserProfile fields take their Prisma schema defaults
          settings: { create: {} }, // all UserSettings fields take their Prisma schema defaults
        },
      });

      // Best-effort: a slow/broken mail provider shouldn't fail registration
      // itself. The account exists either way; resend-verification covers
      // the case where this particular send didn't land.
      try {
        await issueOtp(app, user.id, user.email, "VERIFY_EMAIL");
      } catch (err) {
        app.log.error(err, "Failed to send verification email on register");
      }

      const { accessToken, refreshToken } = await issueTokenPair(app, user);
      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
      reply.setCookie(ROLE_COOKIE_NAME, user.role, roleCookieOptions);

      return reply.code(201).send({ accessToken, user: toAuthUserView(user) });
    },
  );

  app.post<{ Body: LoginRequestBody; Reply: AuthTokenResponse | ErrorResponse }>(
    "/login",
    { schema: { body: loginBodySchema } },
    async (request: FastifyRequest<{ Body: LoginRequestBody }>, reply: FastifyReply) => {
      const { email, password } = request.body;

      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.code(401).send({ error: "Invalid email or password" });
      }

      // Revoke prior refresh tokens before issuing a new pair.
      await revokeAllUserRefreshTokens(app, user.id);
      const { accessToken, refreshToken } = await issueTokenPair(app, user);
      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
      reply.setCookie(ROLE_COOKIE_NAME, user.role, roleCookieOptions);

      return reply.send({ accessToken, user: toAuthUserView(user) });
    },
  );

  app.post<{ Reply: AuthTokenResponse | ErrorResponse }>(
    "/refresh",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawToken = request.cookies[REFRESH_COOKIE_NAME];
      if (!rawToken) {
        return reply.code(401).send({ error: "Missing refresh token" });
      }

      const result = await consumeRefreshToken(app, rawToken);
      if (!result) {
        reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
        reply.clearCookie(ROLE_COOKIE_NAME, roleCookieOptions);
        return reply.code(401).send({ error: "Invalid or expired refresh token" });
      }

      const user = await app.prisma.user.findUniqueOrThrow({ where: { id: result.userId } });
      const { accessToken, refreshToken } = await issueTokenPair(app, user);
      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
      reply.setCookie(ROLE_COOKIE_NAME, user.role, roleCookieOptions);

      return reply.send({ accessToken, user: toAuthUserView(user) });
    },
  );

  app.post(
    "/logout",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const rawToken = request.cookies[REFRESH_COOKIE_NAME];
      if (rawToken) {
        await revokeRefreshToken(app, rawToken);
      }
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
      reply.clearCookie(ROLE_COOKIE_NAME, roleCookieOptions);
      return reply.code(204).send();
    },
  );

  // "Sign out of all devices" — revokeAllUserRefreshTokens already existed
  // (login, password reset both call it internally) but was never exposed
  // as a user-facing action. Clears *this* browser's cookies too, same as
  // a normal logout, since this session's own refresh token is revoked too.
  app.post(
    "/logout-all",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      await revokeAllUserRefreshTokens(app, request.user.userId);
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
      reply.clearCookie(ROLE_COOKIE_NAME, roleCookieOptions);
      return reply.code(204).send();
    },
  );

  // --- Email verification --------------------------------------------------

  app.post<{ Body: VerifyEmailRequestBody; Reply: AuthTokenResponse | ErrorResponse }>(
    "/verify-email",
    { schema: { body: verifyEmailBodySchema } },
    async (request: FastifyRequest<{ Body: VerifyEmailRequestBody }>, reply: FastifyReply) => {
      const { email, code } = request.body;

      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.code(400).send({ error: "Invalid code" });
      }
      if (user.emailVerified) {
        // Already verified — treat as success rather than an error so a
        // double-submit (e.g. two tabs) doesn't surface as a failure.
        const { accessToken, refreshToken } = await issueTokenPair(app, user);
        reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
        reply.setCookie(ROLE_COOKIE_NAME, user.role, roleCookieOptions);
        return reply.send({ accessToken, user: toAuthUserView(user) });
      }

      const result = await verifyOtp(app, user.id, "VERIFY_EMAIL", code);
      if (result === "LOCKED") {
        return reply.code(429).send({ error: "Too many incorrect attempts — request a new code" });
      }
      if (result !== "OK") {
        return reply.code(400).send({ error: "Invalid or expired code" });
      }

      const verifiedUser = await app.prisma.user.update({
        where: { id: user.id },
        data: { emailVerified: true },
      });

      // Re-issue tokens so the freshly-verified state is reflected in the
      // access token immediately, without waiting for the next refresh cycle.
      await revokeAllUserRefreshTokens(app, verifiedUser.id);
      const { accessToken, refreshToken } = await issueTokenPair(app, verifiedUser);
      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
      reply.setCookie(ROLE_COOKIE_NAME, verifiedUser.role, roleCookieOptions);

      return reply.send({ accessToken, user: toAuthUserView(verifiedUser) });
    },
  );

  app.post<{ Body: ResendVerificationRequestBody; Reply: MessageResponse }>(
    "/resend-verification",
    { schema: { body: resendVerificationBodySchema }, config: { rateLimit: otpRateLimit } },
    async (request: FastifyRequest<{ Body: ResendVerificationRequestBody }>, reply: FastifyReply) => {
      const { email } = request.body;
      const user = await app.prisma.user.findUnique({ where: { email } });

      // Always 200 regardless of whether the account exists or is already
      // verified — don't leak account existence via response shape.
      if (user && !user.emailVerified) {
        try {
          await issueOtp(app, user.id, user.email, "VERIFY_EMAIL");
        } catch (err) {
          app.log.error(err, "Failed to resend verification email");
        }
      }
      return reply.send({ message: "If that account needs verification, a code has been sent." });
    },
  );

  // --- Password reset (OTP) -------------------------------------------------

  app.post<{ Body: ForgotPasswordRequestBody; Reply: MessageResponse }>(
    "/forgot-password",
    { schema: { body: forgotPasswordBodySchema }, config: { rateLimit: otpRateLimit } },
    async (request: FastifyRequest<{ Body: ForgotPasswordRequestBody }>, reply: FastifyReply) => {
      const { email } = request.body;
      const user = await app.prisma.user.findUnique({ where: { email } });

      // Always 200 — don't leak account existence.
      if (user) {
        try {
          await issueOtp(app, user.id, user.email, "RESET_PASSWORD");
        } catch (err) {
          app.log.error(err, "Failed to send password reset email");
        }
      }
      return reply.send({ message: "If that account exists, a reset code has been sent." });
    },
  );

  app.post<{ Body: ResetPasswordRequestBody; Reply: MessageResponse | ErrorResponse }>(
    "/reset-password",
    { schema: { body: resetPasswordBodySchema }, config: { rateLimit: otpRateLimit } },
    async (request: FastifyRequest<{ Body: ResetPasswordRequestBody }>, reply: FastifyReply) => {
      const { email, code, newPassword } = request.body;

      const user = await app.prisma.user.findUnique({ where: { email } });
      if (!user) {
        return reply.code(400).send({ error: "Invalid code" });
      }

      const result = await verifyOtp(app, user.id, "RESET_PASSWORD", code);
      if (result === "LOCKED") {
        return reply.code(429).send({ error: "Too many incorrect attempts — request a new code" });
      }
      if (result !== "OK") {
        return reply.code(400).send({ error: "Invalid or expired code" });
      }

      const passwordHash = await hashPassword(newPassword);
      await app.prisma.user.update({ where: { id: user.id }, data: { passwordHash } });

      // A password reset must kill every other session, exactly like a
      // credential rotation — reuse the same helper `login` doesn't even
      // need here (login only revokes its own prior tokens, this revokes on
      // behalf of a possibly-compromised account).
      await revokeAllUserRefreshTokens(app, user.id);
      reply.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
      reply.clearCookie(ROLE_COOKIE_NAME, roleCookieOptions);

      return reply.send({ message: "Password has been reset. Please log in again." });
    },
  );

  await app.register(oauthRoutes);
};

export default authRoutes;
