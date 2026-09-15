import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __shikkhaPrisma: PrismaClient | undefined;
}

// Reuse a single PrismaClient instance across hot-reloads / workspace imports.
export const prisma: PrismaClient = global.__shikkhaPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__shikkhaPrisma = prisma;
}

export * from "@prisma/client";
