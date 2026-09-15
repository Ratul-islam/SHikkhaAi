import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import fastifyMultipart from "@fastify/multipart";

// Whole NCTB textbooks (all chapters in one PDF, scanned) run 50MB+.
export const MAX_PDF_BYTES = 100 * 1024 * 1024; // 100MB

export default fp(async function multipartPlugin(app: FastifyInstance) {
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MAX_PDF_BYTES,
      files: 1,
    },
  });
});
