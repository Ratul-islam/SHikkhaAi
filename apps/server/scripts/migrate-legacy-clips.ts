/**
 * One-off: marks pre-Manim `LessonVideo` rows as legacy clips.
 *
 *   npm run migrate:legacy-clips --workspace=apps/server
 *
 * Those rows are 4-8 second veo/wan footage fragments, not lessons. The new
 * `kind` column defaults to "LESSON", which is correct for everything written
 * from now on and wrong for everything written before — so without this they
 * would be candidates for lesson reuse and a student would be served an 8-second
 * clip of a cricket bat in place of a lesson.
 *
 * They are relabelled rather than deleted: their URLs may still appear in a
 * student's history, and a 404 there is worse than a row nothing queries.
 *
 * Idempotent.
 */

import { PrismaClient } from "@shikkha-ai/database";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  // A pre-Manim row is identifiable without guesswork: it has no DirectedScript
  // and no scenes, because neither column existed when it was written.
  const updated = await prisma.$executeRaw`
    UPDATE "LessonVideo" SET kind = 'CLIP' WHERE script IS NULL AND "sceneCount" = 0 AND kind <> 'CLIP'`;

  const byKind = await prisma.lessonVideo.groupBy({ by: ["kind"], _count: true });

  process.stdout.write(`\n✓ Marked ${updated} legacy row(s) as CLIP\n`);
  for (const row of byKind) {
    process.stdout.write(`  ${row.kind.padEnd(8)} ${row._count}\n`);
  }
  process.stdout.write(`  rendered-scene cache: ${await prisma.renderedScene.count()} row(s)\n\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
