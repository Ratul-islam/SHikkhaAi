import type { FastifyInstance } from "fastify";
import type { CompleteProgressResponse } from "./progress.schema";

export class NodeNotFoundError extends Error {}

/**
 * Marks a node complete, awards XP once, and reports what that unlocked.
 *
 * `score` is INTERNAL — it comes from the Mastery Check's server-side grader
 * (mastery.service.ts) and must never be threaded through from a request body.
 * See progress.schema.ts for why.
 *
 * No prerequisite gate: a student can pass a Mastery Check (and so complete
 * a node) out of roadmap order — the LOCKED/UNLOCKED status the roadmap
 * shows is a recommended path, not an access control. This used to throw
 * NodeLockedError here, which meant the *only* place the check could ever
 * actually fire was after a student had already generated and passed a
 * mastery paper for a node mastery.service.ts's own startMasteryCheck had
 * let them start — turning a passing score into an unhandled 500 instead of
 * the completion it earned. Removed at the same time as the equivalent
 * checks in lesson.service.ts and mastery.service.ts, all three enforcing
 * the same now-retired gate.
 */
export async function completeNode(
  app: FastifyInstance,
  userId: string,
  nodeId: string,
  score: number | undefined,
): Promise<CompleteProgressResponse> {
  const node = await app.prisma.curriculumNode.findUnique({ where: { id: nodeId } });
  if (!node) {
    throw new NodeNotFoundError(`CurriculumNode ${nodeId} not found`);
  }

  const existingProgress = await app.prisma.userProgress.findMany({ where: { userId } });
  const completedNodeIds = new Set(
    existingProgress.filter((p) => p.status === "COMPLETED").map((p) => p.nodeId),
  );

  const alreadyCompleted = completedNodeIds.has(nodeId);

  await app.prisma.userProgress.upsert({
    where: { userId_nodeId: { userId, nodeId } },
    create: {
      userId,
      nodeId,
      status: "COMPLETED",
      score: score ?? 0,
      completedAt: new Date(),
    },
    update: {
      status: "COMPLETED",
      score: score ?? undefined,
      completedAt: new Date(),
    },
  });

  const xpAwarded = alreadyCompleted ? 0 : node.totalXp;
  const user = await app.prisma.user.update({
    where: { id: userId },
    data: xpAwarded > 0 ? { xp: { increment: xpAwarded } } : {},
  });

  // Best-effort "what unlocked" signal for the frontend: nodes that listed
  // this node as a prerequisite and now have every prerequisite satisfied.
  completedNodeIds.add(nodeId);
  const dependents = await app.prisma.curriculumNode.findMany({
    where: { prerequisites: { has: nodeId } },
  });
  const newlyUnlockedNodeIds = dependents
    .filter((d) => !completedNodeIds.has(d.id) && d.prerequisites.every((id) => completedNodeIds.has(id)))
    .map((d) => d.id);

  return {
    nodeId,
    xpAwarded,
    totalXp: user.xp,
    newlyUnlockedNodeIds,
  };
}
