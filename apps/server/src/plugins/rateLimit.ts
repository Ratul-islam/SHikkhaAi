import fp from "fastify-plugin";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";

/**
 * Global default is intentionally lenient (this app isn't otherwise
 * rate-limited) — the point of registering it here is so routes can opt
 * into a *stricter* limit via `{ config: { rateLimit: {...} } }`, which is
 * how the OTP endpoints in auth.routes.ts use it. A route with no override
 * just gets the generous default and is effectively unlimited in practice.
 */
export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    global: true,
    max: 1000,
    timeWindow: "1 minute",
  });
});

/**
 * Keys by the authenticated user, falling back to IP for anything hit
 * before `authenticate` runs. Model-quota-burning routes (chat, mastery,
 * lessons) use this instead of the library's IP-only default: several
 * students behind the same NAT/campus IP shouldn't share one bucket, and
 * one compromised or scripted account should be capped regardless of which
 * IP it's calling from.
 */
export function keyByUser(request: FastifyRequest): string {
  return request.user?.userId ?? request.ip;
}

/** Shared shape for the model-quota-burning routes below — a few requests per minute is normal chat pace, not a bot loop. */
export const CHAT_RATE_LIMIT = { max: 20, timeWindow: "1 minute", keyGenerator: keyByUser };
export const MASTERY_RATE_LIMIT = { max: 10, timeWindow: "1 minute", keyGenerator: keyByUser };
export const LESSON_RATE_LIMIT = { max: 10, timeWindow: "1 minute", keyGenerator: keyByUser };
