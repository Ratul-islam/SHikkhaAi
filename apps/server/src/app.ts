import Fastify, { type FastifyInstance } from "fastify";
import sensible from "@fastify/sensible";
import prismaPlugin from "./plugins/prisma";
import jwtPlugin from "./plugins/jwt";
import multipartPlugin from "./plugins/multipart";
import staticPlugin from "./plugins/static";
import rateLimitPlugin from "./plugins/rateLimit";
import uploadsRetentionPlugin from "./plugins/uploadsRetention";
import securityPlugin from "./plugins/security";
import notificationsSchedulerPlugin from "./plugins/notificationsScheduler";
import authRoutes from "./modules/auth/auth.routes";
import ingestionRoutes from "./modules/ingestion/ingestion.routes";
import chatRoutes from "./modules/chat/chat.routes";
import timestampAskRoutes from "./modules/chat/timestamp-ask";
import lessonRoutes from "./modules/chat/lesson.routes";
import roadmapRoutes from "./modules/roadmap/roadmap.routes";
import nodesRoutes from "./modules/nodes/nodes.routes";
import progressRoutes from "./modules/progress/progress.routes";
import profileRoutes from "./modules/profile/profile.routes";
import masteryRoutes from "./modules/mastery/mastery.routes";
import synthesisRoutes from "./modules/synthesis/synthesis.routes";
import analyticsRoutes from "./modules/analytics/analytics.routes";
import videoRoutes from "./modules/video/video.routes";
import { MAX_PDF_BYTES } from "./plugins/multipart";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: true,
    // Fastify's default (1MB) would reject whole-textbook PDF uploads
    // before @fastify/multipart's own fileSize limit ever gets a say.
    bodyLimit: MAX_PDF_BYTES + 1024 * 1024,
  });

  app.register(sensible);
  app.register(securityPlugin);
  app.register(prismaPlugin);
  app.register(jwtPlugin);
  app.register(multipartPlugin);
  app.register(staticPlugin);
  app.register(rateLimitPlugin);
  app.register(uploadsRetentionPlugin);
  app.register(notificationsSchedulerPlugin);

  app.register(authRoutes, { prefix: "/api/v1/auth" });
  app.register(ingestionRoutes, { prefix: "/api/v1/admin" });
  app.register(chatRoutes, { prefix: "/api/v1/chat" });
  app.register(timestampAskRoutes, { prefix: "/api/v1/chat" });
  app.register(lessonRoutes, { prefix: "/api/v1/lessons" });
  app.register(roadmapRoutes, { prefix: "/api/v1/roadmap" });
  app.register(nodesRoutes, { prefix: "/api/v1/admin/nodes" });
  app.register(progressRoutes, { prefix: "/api/v1/progress" });
  app.register(profileRoutes, { prefix: "/api/v1/profile" });
  app.register(masteryRoutes, { prefix: "/api/v1/mastery" });
  app.register(synthesisRoutes, { prefix: "/api/v1/admin" });
  app.register(analyticsRoutes, { prefix: "/api/v1/admin/analytics" });
  app.register(videoRoutes, { prefix: "/api/v1/video" });

  app.get("/health", async () => ({ status: "ok" }));

  return app;
}
