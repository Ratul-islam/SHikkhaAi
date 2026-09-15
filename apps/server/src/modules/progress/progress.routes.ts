import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth/auth.hooks";
import { completeProgressBodySchema, type CompleteProgressBody, type ErrorResponse } from "./progress.schema";

const progressRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  /**
   * Deprecated as of Phase 1. Completion is now a *consequence* of passing a
   * Mastery Check, not something a client can assert — so this endpoint no
   * longer completes anything.
   *
   * It's kept (rather than deleted) so a stale client gets an explanation
   * instead of a bare 404, and so the deprecation is discoverable from the
   * route table. Remove it once no client references it.
   */
  app.post<{ Body: CompleteProgressBody; Reply: ErrorResponse }>(
    "/complete",
    { preHandler: authenticate, schema: { body: completeProgressBodySchema } },
    async (_request: FastifyRequest<{ Body: CompleteProgressBody }>, reply: FastifyReply) => {
      return reply.code(400).send({
        error:
          "Levels are completed by passing their Mastery Check. POST /api/v1/mastery/:nodeId/start, then /api/v1/mastery/:attemptId/submit.",
      });
    },
  );
};

export default progressRoutes;
