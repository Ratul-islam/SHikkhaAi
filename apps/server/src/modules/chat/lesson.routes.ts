import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireVerified } from "../auth/auth.hooks";
import { LESSON_RATE_LIMIT } from "../../plugins/rateLimit";
import { NodeNotFoundError, OutlineGenerationError, startOrResumeLesson } from "./lesson.service";
import type { ErrorResponse, StartLessonResponse } from "./lesson.schema";

const lessonRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Params: { nodeId: string }; Reply: StartLessonResponse | ErrorResponse }>(
    "/:nodeId/start",
    { preHandler: [authenticate, requireVerified], config: { rateLimit: LESSON_RATE_LIMIT } },
    async (request: FastifyRequest<{ Params: { nodeId: string } }>, reply: FastifyReply) => {
      try {
        const result = await startOrResumeLesson(app, request.user.userId, request.params.nodeId);
        return reply.code(201).send(result);
      } catch (err) {
        if (err instanceof NodeNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        if (err instanceof OutlineGenerationError) {
          request.log.error(err, "Lesson outline generation failed");
          return reply
            .code(503)
            .send({ error: "Couldn't put a lesson together right now — give it another go in a moment." });
        }
        request.log.error(err, "Failed to start guided lesson");
        return reply.code(500).send({ error: "Failed to start the guided lesson" });
      }
    },
  );
};

export default lessonRoutes;
