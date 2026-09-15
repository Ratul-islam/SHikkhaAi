import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { OAuth2Client } from "google-auth-library";
import { env, isGitHubOAuthConfigured, isGoogleOAuthConfigured } from "../../config/env";
import { generateDefaultAvatar } from "../../lib/avatar";
import {
  REFRESH_COOKIE_NAME,
  ROLE_COOKIE_NAME,
  issueTokenPair,
  refreshCookieOptions,
  roleCookieOptions,
} from "./auth.service";

/**
 * A verified identity handed back by any provider's callback, normalized to
 * the fields find-or-create needs. Adding GitHub later means adding one more
 * function shaped like `exchangeGoogleCode`/`verifyGoogleIdToken` below plus
 * one more pair of routes calling the shared `findOrCreateOAuthUser` — no
 * change to that shared logic or to the schema.
 */
interface OAuthProfile {
  provider: string;
  providerAccountId: string;
  email: string;
  name: string;
  /** Phase 3 — Google's own `picture` claim, when the provider has one. Falls back to a generated avatar (same as a password signup) when absent. */
  avatarUrl?: string;
}

async function findOrCreateOAuthUser(app: FastifyInstance, profile: OAuthProfile) {
  const existingLink = await app.prisma.authProvider.findUnique({
    where: { provider_providerAccountId: { provider: profile.provider, providerAccountId: profile.providerAccountId } },
    include: { user: true },
  });
  if (existingLink) {
    return existingLink.user;
  }

  // No link yet — but an account with this email may already exist (e.g.
  // originally created via password signup). Link the provider to it rather
  // than creating a duplicate user for the same person.
  const existingUser = await app.prisma.user.findUnique({ where: { email: profile.email } });
  if (existingUser) {
    await app.prisma.authProvider.create({
      data: { provider: profile.provider, providerAccountId: profile.providerAccountId, userId: existingUser.id },
    });
    // The provider already asserts ownership of this email address.
    return existingUser.emailVerified
      ? existingUser
      : app.prisma.user.update({ where: { id: existingUser.id }, data: { emailVerified: true } });
  }

  return app.prisma.user.create({
    data: {
      email: profile.email,
      name: profile.name,
      passwordHash: null,
      emailVerified: true, // the provider already verified this email
      avatarUrl: profile.avatarUrl ?? generateDefaultAvatar(profile.email, profile.name),
      profile: { create: {} },
      settings: { create: {} },
      authProviders: {
        create: { provider: profile.provider, providerAccountId: profile.providerAccountId },
      },
    },
  });
}

async function completeOAuthLogin(app: FastifyInstance, reply: FastifyReply, profile: OAuthProfile): Promise<void> {
  const user = await findOrCreateOAuthUser(app, profile);
  const { refreshToken } = await issueTokenPair(app, user);
  reply.setCookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions);
  reply.setCookie(ROLE_COOKIE_NAME, user.role, roleCookieOptions);
  // No access token in the URL — the frontend's /oauth/callback page calls
  // POST /auth/refresh (existing route) to trade the now-set cookie for one,
  // same as any other session bootstrap. See auth.routes.ts's /refresh.
  reply.redirect(`${env.WEB_APP_URL}/oauth/callback`);
}

const oauthRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/google", async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!isGoogleOAuthConfigured()) {
      return reply.code(503).send({ error: "Google sign-in is not configured on this server" });
    }
    const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
    const url = client.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      prompt: "select_account",
    });
    return reply.redirect(url);
  });

  app.get<{ Querystring: { code?: string; error?: string } }>(
    "/google/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string; error?: string } }>, reply: FastifyReply) => {
      if (!isGoogleOAuthConfigured()) {
        return reply.code(503).send({ error: "Google sign-in is not configured on this server" });
      }
      const { code, error } = request.query;
      if (error || !code) {
        return reply.redirect(`${env.WEB_APP_URL}/login?error=oauth_failed`);
      }

      const client = new OAuth2Client(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI);
      try {
        const { tokens } = await client.getToken(code);
        const ticket = await client.verifyIdToken({
          idToken: tokens.id_token ?? "",
          audience: env.GOOGLE_CLIENT_ID,
        });
        const payload = ticket.getPayload();
        if (!payload?.email) {
          return reply.redirect(`${env.WEB_APP_URL}/login?error=oauth_failed`);
        }

        await completeOAuthLogin(app, reply, {
          provider: "GOOGLE",
          providerAccountId: payload.sub,
          email: payload.email,
          name: payload.name ?? payload.email,
          avatarUrl: payload.picture,
        });
      } catch (err) {
        app.log.error(err, "Google OAuth callback failed");
        return reply.redirect(`${env.WEB_APP_URL}/login?error=oauth_failed`);
      }
    },
  );

  // GitHub — the second provider the auth system was explicitly designed
  // for (see the OAuthProfile/findOrCreateOAuthUser comment above). No new
  // library: GitHub's OAuth flow is plain REST (authorize redirect, a
  // token-exchange POST, then two authenticated GETs), so plain fetch
  // (Node 18+ global) is enough — pulling in a whole client for two calls
  // wasn't worth it the way google-auth-library's ID-token verification was.
  app.get("/github", async (_request: FastifyRequest, reply: FastifyReply) => {
    if (!isGitHubOAuthConfigured()) {
      return reply.code(503).send({ error: "GitHub sign-in is not configured on this server" });
    }
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", env.GITHUB_CLIENT_ID!);
    url.searchParams.set("redirect_uri", env.GITHUB_REDIRECT_URI!);
    url.searchParams.set("scope", "read:user user:email");
    return reply.redirect(url.toString());
  });

  app.get<{ Querystring: { code?: string; error?: string } }>(
    "/github/callback",
    async (request: FastifyRequest<{ Querystring: { code?: string; error?: string } }>, reply: FastifyReply) => {
      if (!isGitHubOAuthConfigured()) {
        return reply.code(503).send({ error: "GitHub sign-in is not configured on this server" });
      }
      const { code, error } = request.query;
      if (error || !code) {
        return reply.redirect(`${env.WEB_APP_URL}/login?error=oauth_failed`);
      }

      try {
        const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            redirect_uri: env.GITHUB_REDIRECT_URI,
            code,
          }),
        });
        const tokenBody = (await tokenResponse.json()) as { access_token?: string; error?: string };
        if (!tokenBody.access_token) {
          throw new Error(`GitHub token exchange failed: ${tokenBody.error ?? "no access_token in response"}`);
        }

        const githubHeaders = {
          Authorization: `Bearer ${tokenBody.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "ShikkhaAI",
        };
        const [userResponse, emailsResponse] = await Promise.all([
          fetch("https://api.github.com/user", { headers: githubHeaders }),
          fetch("https://api.github.com/user/emails", { headers: githubHeaders }),
        ]);
        const user = (await userResponse.json()) as { id: number; name: string | null; login: string; avatar_url?: string };
        const emails = (await emailsResponse.json()) as { email: string; primary: boolean; verified: boolean }[];

        // GitHub's /user.email is null unless the user made it public — the
        // /user/emails endpoint (needs the user:email scope) is the
        // reliable source, filtered to one GitHub itself has verified.
        const primaryEmail = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) : undefined;
        if (!primaryEmail) {
          return reply.redirect(`${env.WEB_APP_URL}/login?error=oauth_failed`);
        }

        await completeOAuthLogin(app, reply, {
          provider: "GITHUB",
          providerAccountId: String(user.id),
          email: primaryEmail.email,
          name: user.name ?? user.login,
          avatarUrl: user.avatar_url,
        });
      } catch (err) {
        app.log.error(err, "GitHub OAuth callback failed");
        return reply.redirect(`${env.WEB_APP_URL}/login?error=oauth_failed`);
      }
    },
  );
};

export default oauthRoutes;
