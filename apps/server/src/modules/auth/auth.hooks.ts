import type { FastifyRequest, FastifyReply } from "fastify";
import type { AccessTokenPayload } from "../../types/fastify";

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    const payload = await request.jwtVerify<AccessTokenPayload>();
    request.user = payload;
  } catch {
    await reply.code(401).send({ error: "Unauthorized" });
  }
}

export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  if (request.user.role !== "ADMIN") {
    await reply.code(403).send({ error: "Forbidden: admin role required" });
  }
}

/**
 * Gates a route on a verified email. Reads `emailVerified` off the access
 * token rather than re-querying the DB — the token is re-issued (via login,
 * refresh, or the verify-email route itself) whenever that flag changes, so
 * it's never more than one refresh cycle stale. Chain after `authenticate`.
 */
export async function requireVerified(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.user) {
    await reply.code(401).send({ error: "Unauthorized" });
    return;
  }
  if (!request.user.emailVerified) {
    await reply.code(403).send({ error: "Please verify your email address before continuing" });
  }
}
