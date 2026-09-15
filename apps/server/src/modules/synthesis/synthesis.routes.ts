import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireAdmin } from "../auth/auth.hooks";
import { NoContentError, SynthesisFailedError, synthesizeLevels } from "./synthesis.service";
import {
  synthesizeLevelsBodySchema,
  type ErrorResponse,
  type SynthesizeLevelsBody,
  type SynthesizeLevelsResponse,
} from "./synthesis.schema";

const synthesisRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: SynthesizeLevelsBody; Reply: SynthesizeLevelsResponse | ErrorResponse }>(
    "/synthesize-levels",
    { preHandler: [authenticate, requireAdmin], schema: { body: synthesizeLevelsBodySchema } },
    async (request: FastifyRequest<{ Body: SynthesizeLevelsBody }>, reply: FastifyReply) => {
      try {
        const result = await synthesizeLevels(app, request.body);
        return reply.send(result);
      } catch (err) {
        if (err instanceof NoContentError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof SynthesisFailedError) {
          request.log.error(err, "Level synthesis failed");
          return reply.code(503).send({ error: "Couldn't synthesize levels for this chapter — try again." });
        }
        request.log.error(err, "Level synthesis failed unexpectedly");
        return reply.code(500).send({ error: "Failed to synthesize levels" });
      }
    },
  );
};

export default synthesisRoutes;
