import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth/auth.hooks";
import {
  REFRESH_COOKIE_NAME,
  ROLE_COOKIE_NAME,
  issueTokenPair,
  refreshCookieOptions,
  roleCookieOptions,
} from "../auth/auth.service";
import {
  getProfile,
  updateProfile,
  updateClassLevel,
  updateSettings,
  updateAvatar,
  getStats,
  InvalidAvatarError,
} from "./profile.service";
import { listEarnedBadges } from "../badges/badges.service";
import {
  updateProfileBodySchema,
  updateClassBodySchema,
  updateSettingsBodySchema,
  updateAvatarBodySchema,
  type ErrorResponse,
  type ProfileView,
  type ProfileStatsResponse,
  type EarnedBadgeView,
  type UpdateAvatarBody,
  type UpdateClassBody,
  type UpdateProfileBody,
  type UpdateSettingsBody,
} from "./profile.schema";

/** Returned by the class-change route only — classLevel is baked into the access token (see types/fastify.d.ts), so changing it means re-issuing one, same as the emailVerified flip in auth.routes.ts's verify-email. */
interface UpdateClassResponse {
  accessToken: string;
  profile: ProfileView;
}

const profileRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Reply: ProfileView | ErrorResponse }>(
    "/me",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const profile = await getProfile(app, request.user.userId);
      return reply.send(profile);
    },
  );

  app.patch<{ Body: UpdateProfileBody; Reply: ProfileView | ErrorResponse }>(
    "/me",
    { preHandler: authenticate, schema: { body: updateProfileBodySchema } },
    async (request: FastifyRequest<{ Body: UpdateProfileBody }>, reply: FastifyReply) => {
      const profile = await updateProfile(app, request.user.userId, request.body);
      return reply.send(profile);
    },
  );

  app.patch<{ Body: UpdateClassBody; Reply: UpdateClassResponse | ErrorResponse }>(
    "/class",
    { preHandler: authenticate, schema: { body: updateClassBodySchema } },
    async (request: FastifyRequest<{ Body: UpdateClassBody }>, reply: FastifyReply) => {
      const profile = await updateClassLevel(app, request.user.userId, request.body.classLevel);

      // classLevel is part of the access token payload (roadmap/chat default
      // to it) — re-issue so the change takes effect immediately rather than
      // waiting for the next /auth/refresh cycle.
      const { accessToken, refreshToken } = await issueTokenPair(app, {
        id: profile.id,
        role: profile.role,
        classLevel: profile.classLevel,
        emailVerified: profile.emailVerified,
      });
      reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
      reply.setCookie(ROLE_COOKIE_NAME, profile.role, roleCookieOptions);

      return reply.send({ accessToken, profile });
    },
  );

  app.patch<{ Body: UpdateSettingsBody; Reply: ProfileView | ErrorResponse }>(
    "/settings",
    { preHandler: authenticate, schema: { body: updateSettingsBodySchema } },
    async (request: FastifyRequest<{ Body: UpdateSettingsBody }>, reply: FastifyReply) => {
      const profile = await updateSettings(app, request.user.userId, request.body);
      return reply.send(profile);
    },
  );

  app.patch<{ Body: UpdateAvatarBody; Reply: ProfileView | ErrorResponse }>(
    "/avatar",
    { preHandler: authenticate, schema: { body: updateAvatarBodySchema } },
    async (request: FastifyRequest<{ Body: UpdateAvatarBody }>, reply: FastifyReply) => {
      try {
        const profile = await updateAvatar(app, request.user.userId, request.body);
        return reply.send(profile);
      } catch (err) {
        if (err instanceof InvalidAvatarError) {
          return reply.code(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  app.get<{ Reply: ProfileStatsResponse | ErrorResponse }>(
    "/stats",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const stats = await getStats(app, request.user.userId);
      return reply.send(stats);
    },
  );

  app.get<{ Reply: { badges: EarnedBadgeView[] } | ErrorResponse }>(
    "/badges",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const badges = await listEarnedBadges(app, request.user.userId);
      return reply.send({ badges: badges.map((b) => ({ ...b, earnedAt: b.earnedAt.toISOString() })) });
    },
  );
};

export default profileRoutes;
