import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";

/**
 * Baseline security headers (X-Content-Type-Options, X-Frame-Options,
 * Referrer-Policy, etc.) — this server had none. Content-Security-Policy is
 * disabled: this is a JSON API plus a static /uploads folder of narration
 * audio (video.routes.ts), never HTML the browser renders as a document, so
 * a CSP here has nothing meaningful to constrain and risks fighting the
 * frontend's own CSP (that one's real and enforced — see the Artifact/CSP
 * notes in apps/web) for no benefit.
 */
export default fp(async function securityPlugin(app: FastifyInstance) {
  await app.register(helmet, {
    contentSecurityPolicy: false,
  });
});
