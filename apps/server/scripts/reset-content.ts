/**
 * One-off: wipes a class/subject's ingested content and roadmap levels, so a
 * book can be re-ingested cleanly through whole-book ingestion.
 *
 *   npm run reset:content --workspace=apps/server -- <classLevel> <subject> [<subject>...] [--apply]
 *
 * Dry run by default — prints what would go. With --apply, deletes in one
 * transaction:
 *   - every DocumentChunk for the class and subject(s)
 *   - every Chapter (and its Topics) for them
 *   - every CurriculumNode for them, plus the rows that reference those nodes
 *     by foreign key (UserProgress, MasteryAttempt, LessonSession)
 *
 * Deliberately left alone: ChatMessage history (no foreign key; old threads stay
 * readable) and LessonVideo rows (shared paid assets; they only match by nodeId,
 * which simply stops matching).
 *
 * Pass every spelling a subject was stored under ("physics" "Physics") — the
 * legacy single-chapter upload stored whatever the admin typed.
 */

import { PrismaClient } from "@shikkha-ai/database";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const [classArg, ...subjects] = args.filter((a) => !a.startsWith("--"));
  const classLevel = Number(classArg);
  if (!Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12 || subjects.length === 0) {
    throw new Error("Usage: reset:content -- <classLevel> <subject> [<subject>...] [--apply]");
  }

  const scope = { classLevel, subject: { in: subjects } };
  const nodes = await prisma.curriculumNode.findMany({ where: scope, select: { id: true } });
  const nodeIds = nodes.map((n) => n.id);
  const byNode = { nodeId: { in: nodeIds } };

  const counts = {
    documentChunks: await prisma.documentChunk.count({ where: scope }),
    chapters: await prisma.chapter.count({ where: scope }),
    curriculumNodes: nodeIds.length,
    userProgress: await prisma.userProgress.count({ where: byNode }),
    masteryAttempts: await prisma.masteryAttempt.count({ where: byNode }),
    lessonSessions: await prisma.lessonSession.count({ where: byNode }),
  };

  process.stdout.write(`\nClass ${classLevel} · ${subjects.map((s) => `"${s}"`).join(", ")}\n`);
  for (const [name, count] of Object.entries(counts)) process.stdout.write(`  ${name.padEnd(16)} ${count}\n`);

  if (!apply) {
    process.stdout.write(`\nDry run — nothing deleted. Re-run with --apply to delete the rows above.\n\n`);
    return;
  }

  await prisma.$transaction([
    prisma.userProgress.deleteMany({ where: byNode }),
    prisma.masteryAttempt.deleteMany({ where: byNode }),
    prisma.lessonSession.deleteMany({ where: byNode }),
    prisma.curriculumNode.deleteMany({ where: { id: { in: nodeIds } } }),
    prisma.chapter.deleteMany({ where: scope }), // topics cascade
    prisma.documentChunk.deleteMany({ where: scope }),
  ]);
  process.stdout.write(`\n✓ Deleted.\n\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`\n✗ ${(err as Error).message}\n`);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
