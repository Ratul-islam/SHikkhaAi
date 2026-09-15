import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth/auth.hooks";
import { getRoadmapForUser } from "./roadmap.service";
import { roadmapQuerySchema, type ErrorResponse, type RoadmapQuery, type RoadmapResponse } from "./roadmap.schema";

const roadmapRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Querystring: RoadmapQuery; Reply: RoadmapResponse | ErrorResponse }>(
    "/",
    { preHandler: authenticate, schema: { querystring: roadmapQuerySchema } },
    async (request: FastifyRequest<{ Querystring: RoadmapQuery }>, reply: FastifyReply) => {
      const nodes = await getRoadmapForUser(app, request.user.userId, request.user.classLevel, request.query);
      return reply.send({ nodes });
    },
  );
};

export default roadmapRoutes;
