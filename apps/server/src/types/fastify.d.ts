import type { PrismaClient } from "@shikkha-ai/database";

export interface AccessTokenPayload {
  userId: string;
  role: "STUDENT" | "ADMIN";
  classLevel: number;
  emailVerified: boolean;
}

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }

  interface FastifyRequest {
    user: AccessTokenPayload;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: AccessTokenPayload;
    user: AccessTokenPayload;
  }
}
