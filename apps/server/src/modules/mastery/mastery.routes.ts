import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireVerified } from "../auth/auth.hooks";
import { MASTERY_RATE_LIMIT } from "../../plugins/rateLimit";
import {
  AttemptAlreadySubmittedError,
  AttemptNotFoundError,
  NodeNotFoundError,
  QuestionGenerationError,
  startMasteryCheck,
  submitMasteryCheck,
} from "./mastery.service";
import {
  submitMasteryBodySchema,
  type ErrorResponse,
  type StartMasteryResponse,
  type SubmitMasteryBody,
  type SubmitMasteryResponse,
} from "./mastery.schema";

const masteryRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Params: { nodeId: string }; Reply: StartMasteryResponse | ErrorResponse }>(
    "/:nodeId/start",
    { preHandler: [authenticate, requireVerified], config: { rateLimit: MASTERY_RATE_LIMIT } },
    async (request: FastifyRequest<{ Params: { nodeId: string } }>, reply: FastifyReply) => {
      try {
        const result = await startMasteryCheck(app, request.user.userId, request.params.nodeId);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof NodeNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof QuestionGenerationError) {
          request.log.error(err, "Mastery question generation failed");
          return reply
            .code(503)
            .send({ error: "Couldn't put a check together right now — give it another go in a moment." });
        }
        request.log.error(err, "Failed to start mastery check");
        return reply.code(500).send({ error: "Failed to start the mastery check" });
      }
    },
  );

  app.post<{ Params: { attemptId: string }; Body: SubmitMasteryBody; Reply: SubmitMasteryResponse | ErrorResponse }>(
    "/:attemptId/submit",
    { preHandler: [authenticate, requireVerified], schema: { body: submitMasteryBodySchema }, config: { rateLimit: MASTERY_RATE_LIMIT } },
    async (
      request: FastifyRequest<{ Params: { attemptId: string }; Body: SubmitMasteryBody }>,
      reply: FastifyReply,
    ) => {
      try {
        const result = await submitMasteryCheck(
          app,
          request.user.userId,
          request.params.attemptId,
          request.body.answers,
        );
        return reply.send(result);
      } catch (err) {
        if (err instanceof AttemptNotFoundError) {
          return reply.code(404).send({ error: "Attempt not found" });
        }
        if (err instanceof AttemptAlreadySubmittedError) {
          return reply.code(409).send({ error: "This attempt has already been submitted." });
        }
        request.log.error(err, "Failed to submit mastery check");
        return reply.code(500).send({ error: "Failed to grade the mastery check" });
      }
    },
  );
};

export default masteryRoutes;
