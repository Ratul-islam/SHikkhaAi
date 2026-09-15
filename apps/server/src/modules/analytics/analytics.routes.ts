import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireAdmin } from "../auth/auth.hooks";
import { getAnalytics, getStudentDrilldown, listStudents, StudentNotFoundError, type StudentListItem } from "./analytics.service";
import {
  analyticsQuerySchema,
  type AnalyticsQuery,
  type AnalyticsResponse,
  type ErrorResponse,
  type StudentDrilldownResponse,
} from "./analytics.schema";

const analyticsRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Querystring: AnalyticsQuery; Reply: AnalyticsResponse | ErrorResponse }>(
    "/",
    { preHandler: [authenticate, requireAdmin], schema: { querystring: analyticsQuerySchema } },
    async (request: FastifyRequest<{ Querystring: AnalyticsQuery }>, reply: FastifyReply) => {
      const analytics = await getAnalytics(app, request.query);
      return reply.send(analytics);
    },
  );

  app.get<{ Reply: { students: StudentListItem[] } | ErrorResponse }>(
    "/students",
    { preHandler: [authenticate, requireAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const students = await listStudents(app);
      return reply.send({ students });
    },
  );

  app.get<{ Params: { userId: string }; Reply: StudentDrilldownResponse | ErrorResponse }>(
    "/students/:userId",
    { preHandler: [authenticate, requireAdmin] },
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      try {
        const drilldown = await getStudentDrilldown(app, request.params.userId);
        return reply.send(drilldown);
      } catch (err) {
        if (err instanceof StudentNotFoundError) {
          return reply.code(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );
};

export default analyticsRoutes;
