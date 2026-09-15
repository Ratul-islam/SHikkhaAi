import type { FastifyInstance } from "fastify";
import type { RoadmapNodeView, RoadmapQuery, NodeStatus } from "./roadmap.schema";

/**
 * Computes each node's status for a given user: COMPLETED if their
 * UserProgress row says so, UNLOCKED if every prerequisite node is
 * COMPLETED (or the node has none), LOCKED otherwise.
 */
export function computeStatus(
  nodeId: string,
  prerequisites: string[],
  completedNodeIds: Set<string>,
): NodeStatus {
  if (completedNodeIds.has(nodeId)) return "COMPLETED";
  const unlocked = prerequisites.every((prereqId) => completedNodeIds.has(prereqId));
  return unlocked ? "UNLOCKED" : "LOCKED";
}

export async function getRoadmapForUser(
  app: FastifyInstance,
  userId: string,
  defaultClassLevel: number,
  query: RoadmapQuery,
): Promise<RoadmapNodeView[]> {
  const classLevel = query.classLevel ?? defaultClassLevel;

  const [nodes, progressRows] = await Promise.all([
    app.prisma.curriculumNode.findMany({
      where: {
        classLevel,
        ...(query.subject ? { subject: query.subject } : {}),
      },
      orderBy: { orderIndex: "asc" },
    }),
    app.prisma.userProgress.findMany({ where: { userId } }),
  ]);

  const scoreByNode = new Map(progressRows.map((p) => [p.nodeId, p.score]));
  const completedNodeIds = new Set(
    progressRows.filter((p) => p.status === "COMPLETED").map((p) => p.nodeId),
  );

  return nodes.map((node) => ({
    id: node.id,
    classLevel: node.classLevel,
    subject: node.subject,
    chapterNumber: node.chapterNumber,
    title: node.title,
    description: node.description,
    prerequisites: node.prerequisites,
    orderIndex: node.orderIndex,
    totalXp: node.totalXp,
    status: computeStatus(node.id, node.prerequisites, completedNodeIds),
    score: scoreByNode.get(node.id) ?? null,
  }));
}

/**
 * Single-node status lookup — for a caller that wants one node's
 * COMPLETED/UNLOCKED/LOCKED without rendering the whole roadmap. Currently
 * unused: lesson.service.ts, mastery.service.ts, and progress.service.ts all
 * used to gate on this (rejecting an action on a LOCKED node), but that gate
 * was removed — a student can act on any node regardless of roadmap order,
 * so LOCKED is display-only now. Kept as a correct, reusable utility for
 * whatever next needs a single node's status; deliberately still shares
 * computeStatus with getRoadmapForUser so it can never drift from what the
 * roadmap itself shows.
 */
export async function getNodeStatusForUser(
  app: FastifyInstance,
  userId: string,
  node: { id: string; prerequisites: string[] },
): Promise<NodeStatus> {
  const progressRows = await app.prisma.userProgress.findMany({
    where: { userId },
    select: { nodeId: true, status: true },
  });
  const completedNodeIds = new Set(
    progressRows.filter((p) => p.status === "COMPLETED").map((p) => p.nodeId),
  );
  return computeStatus(node.id, node.prerequisites, completedNodeIds);
}
