import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { prisma } from "@shikkha-ai/database";

export default fp(async function prismaPlugin(app: FastifyInstance) {
  app.decorate("prisma", prisma);

  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
});
