import fs from "node:fs/promises";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { UPLOADS_DIR } from "../modules/speech/edge-speech.service";

/**
 * PLAN.md Phase 2 §2.6: every video narration writes an MP3 + a timestamp
 * JSON to `uploads/` and nothing ever cleaned them up — the directory grows
 * unbounded. A video lesson isn't a persisted entity here (video.routes.ts
 * is synchronous and stateless by design; see its own comment), so there's
 * nothing to reference-count against — a simple age-based sweep is the
 * right amount of engineering for "don't grow forever," short of the bigger
 * "should this become a real DB-tracked entity" question PLAN.md leaves open.
 */
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours — well beyond one sitting's chat session
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly

export async function sweepStaleUploads(dir: string, retentionMs: number, now = Date.now()): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0; // nothing uploaded yet
    throw err;
  }

  let deleted = 0;
  await Promise.all(
    entries.map(async (name) => {
      const filePath = `${dir}/${name}`;
      try {
        const stat = await fs.stat(filePath);
        if (now - stat.mtimeMs > retentionMs) {
          await fs.unlink(filePath);
          deleted++;
        }
      } catch {
        // Another sweep (or the request that created it) may have already
        // removed it — a stale-upload sweep racing itself is harmless.
      }
    }),
  );
  return deleted;
}

export default fp(async function uploadsRetentionPlugin(app: FastifyInstance) {
  const runSweep = () => {
    sweepStaleUploads(UPLOADS_DIR, RETENTION_MS)
      .then((deleted) => {
        if (deleted > 0) app.log.info({ deleted }, "Swept stale video-narration uploads");
      })
      .catch((err) => app.log.error(err, "Uploads retention sweep failed"));
  };

  runSweep(); // once on boot, so a long-running server doesn't wait a full interval to start clearing a backlog
  const interval = setInterval(runSweep, SWEEP_INTERVAL_MS);
  app.addHook("onClose", (_instance, done) => {
    clearInterval(interval);
    done();
  });
});
