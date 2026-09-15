/**
 * Moves lesson clips still stored locally (`MEDIA_STORE=local`) into the
 * configured object store, and repoints their LessonVideo rows.
 *
 *   npm run migrate:media --workspace=apps/server
 *
 * Needed because clips generated before R2 was configured live under
 * `apps/server/media/`, which does not survive a redeploy. Idempotent: rows
 * already on an absolute URL are skipped, so re-running is safe.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";
import { putMedia, MEDIA_DIR } from "../src/lib/mediaStore";
import { env } from "../src/config/env";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  if (env.MEDIA_STORE === "local") {
    console.error("MEDIA_STORE is still 'local' — set it to r2 (or cloudinary) first, or this would be a no-op.");
    process.exit(1);
  }

  const rows = await prisma.lessonVideo.findMany({ where: { url: { startsWith: "/media/" } } });
  console.log(`${rows.length} clip(s) to migrate to ${env.MEDIA_STORE}`);

  for (const row of rows) {
    const name = path.basename(row.url);
    const file = path.join(MEDIA_DIR, name);
    try {
      const buffer = await fs.readFile(file);
      const stored = await putMedia(name, buffer);
      await prisma.lessonVideo.update({ where: { id: row.id }, data: { url: stored.url } });
      console.log(`  ✓ ${name} → ${stored.url}`);
    } catch (err) {
      // A missing local file means the clip is simply gone; the row is left
      // pointing at the dead path rather than deleted, so it stays visible as
      // something to regenerate rather than silently vanishing from the library.
      console.error(`  ✗ ${name}: ${String(err).slice(0, 160)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
