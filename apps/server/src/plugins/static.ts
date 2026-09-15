import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { UPLOADS_DIR } from "../modules/speech/edge-speech.service";
import { MEDIA_DIR } from "../lib/mediaStore";

export default fp(async function staticPlugin(app: FastifyInstance) {
  await app.register(fastifyStatic, {
    root: UPLOADS_DIR,
    prefix: "/uploads/",
    decorateReply: false,
  });

  // Durable media (generated lesson clips) when MEDIA_STORE=local. Served from
  // its own directory precisely so uploadsRetention.ts's 24h sweep never
  // reaches it — a paid, reusable asset must outlive one sitting. With
  // MEDIA_STORE=r2/cloudinary nothing is written here and this simply serves
  // an empty directory.
  await app.register(fastifyStatic, {
    root: MEDIA_DIR,
    prefix: "/media/",
    decorateReply: false,
  });
});
