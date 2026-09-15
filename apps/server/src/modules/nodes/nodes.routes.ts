import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireAdmin } from "../auth/auth.hooks";
import {
  bulkCreateNodesBodySchema,
  createNodeBodySchema,
  updateNodeBodySchema,
  type BulkCreateNodesBody,
  type BulkCreateNodesResponse,
  type BulkNodeInput,
  type CreateNodeBody,
  type ErrorResponse,
  type NodeListResponse,
  type UpdateNodeBody,
  type CurriculumNodeView,
} from "./nodes.schema";

/**
 * Validates the tempKey graph before anything is written: duplicate keys,
 * references to keys that aren't in the batch, self-references, and cycles.
 *
 * Returns a human-readable reason, or null when the graph is sound. Cycles are
 * caught with an iterative DFS (three-colour marking) rather than by trusting
 * the order the levels arrived in — an admin can reorder them in the review UI.
 */
function validateLevelGraph(levels: BulkNodeInput[]): string | null {
  const keys = levels.map((l) => l.tempKey);
  const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (duplicates.length > 0) {
    return `Duplicate tempKey(s): ${[...new Set(duplicates)].join(", ")}`;
  }

  const byKey = new Map(levels.map((l) => [l.tempKey, l]));
  for (const level of levels) {
    for (const key of level.prerequisiteKeys) {
      if (key === level.tempKey) return `Level "${level.tempKey}" lists itself as a prerequisite`;
      if (!byKey.has(key)) return `Level "${level.tempKey}" references unknown prerequisite "${key}"`;
    }
  }

  const UNVISITED = 0;
  const IN_STACK = 1;
  const DONE = 2;
  const state = new Map<string, number>(keys.map((k) => [k, UNVISITED]));

  for (const start of keys) {
    if (state.get(start) !== UNVISITED) continue;
    const stack: { key: string; edge: number }[] = [{ key: start, edge: 0 }];
    state.set(start, IN_STACK);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const prereqs = byKey.get(frame.key)?.prerequisiteKeys ?? [];

      if (frame.edge >= prereqs.length) {
        state.set(frame.key, DONE);
        stack.pop();
        continue;
      }

      const next = prereqs[frame.edge]!;
      frame.edge += 1;

      if (state.get(next) === IN_STACK) {
        return `Prerequisite cycle detected involving "${next}"`;
      }
      if (state.get(next) === UNVISITED) {
        state.set(next, IN_STACK);
        stack.push({ key: next, edge: 0 });
      }
    }
  }

  return null;
}

const nodesRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{ Reply: NodeListResponse | ErrorResponse }>(
    "/",
    { preHandler: [authenticate, requireAdmin] },
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const nodes = await app.prisma.curriculumNode.findMany({ orderBy: { orderIndex: "asc" } });
      return reply.send({ nodes });
    },
  );

  app.post<{ Body: CreateNodeBody; Reply: CurriculumNodeView | ErrorResponse }>(
    "/",
    { preHandler: [authenticate, requireAdmin], schema: { body: createNodeBodySchema } },
    async (request: FastifyRequest<{ Body: CreateNodeBody }>, reply: FastifyReply) => {
      const node = await app.prisma.curriculumNode.create({ data: request.body });
      return reply.code(201).send(node);
    },
  );

  /**
   * Commits a reviewed Level Synthesis draft.
   *
   * Two-step inside one transaction: create every node to learn its real UUID,
   * then rewrite prerequisiteKeys into those UUIDs. The whole batch rolls back
   * if the graph is unsound, so a chapter can never end up half-committed with
   * dangling prerequisites.
   */
  app.post<{ Body: BulkCreateNodesBody; Reply: BulkCreateNodesResponse | ErrorResponse }>(
    "/bulk",
    { preHandler: [authenticate, requireAdmin], schema: { body: bulkCreateNodesBodySchema } },
    async (request: FastifyRequest<{ Body: BulkCreateNodesBody }>, reply: FastifyReply) => {
      const { classLevel, subject, chapterNumber, levels } = request.body;

      const graphError = validateLevelGraph(levels);
      if (graphError) {
        return reply.code(400).send({ error: graphError });
      }

      try {
        const nodes = await app.prisma.$transaction(async (tx) => {
          const idByKey = new Map<string, string>();

          for (const level of levels) {
            const created = await tx.curriculumNode.create({
              data: {
                classLevel,
                subject,
                chapterNumber,
                title: level.title,
                description: level.description,
                orderIndex: level.orderIndex,
                totalXp: level.totalXp ?? 100,
                sourcePages: level.sourcePages ?? [],
                synthesized: true,
                prerequisites: [],
              },
            });
            idByKey.set(level.tempKey, created.id);
          }

          return Promise.all(
            levels.map((level) =>
              tx.curriculumNode.update({
                where: { id: idByKey.get(level.tempKey)! },
                data: {
                  prerequisites: level.prerequisiteKeys.map((key) => idByKey.get(key)!),
                },
              }),
            ),
          );
        });

        return reply.code(201).send({ created: nodes.length, nodes });
      } catch (err) {
        request.log.error(err, "Bulk node creation failed");
        return reply.code(500).send({ error: "Failed to commit the synthesized levels" });
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: UpdateNodeBody; Reply: CurriculumNodeView | ErrorResponse }>(
    "/:id",
    { preHandler: [authenticate, requireAdmin], schema: { body: updateNodeBodySchema } },
    async (request: FastifyRequest<{ Params: { id: string }; Body: UpdateNodeBody }>, reply: FastifyReply) => {
      const existing = await app.prisma.curriculumNode.findUnique({ where: { id: request.params.id } });
      if (!existing) {
        return reply.code(404).send({ error: "Node not found" });
      }
      const node = await app.prisma.curriculumNode.update({
        where: { id: request.params.id },
        data: request.body,
      });
      return reply.send(node);
    },
  );

  app.delete<{ Params: { id: string }; Reply: ErrorResponse | undefined }>(
    "/:id",
    { preHandler: [authenticate, requireAdmin] },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const existing = await app.prisma.curriculumNode.findUnique({ where: { id: request.params.id } });
      if (!existing) {
        return reply.code(404).send({ error: "Node not found" });
      }
      await app.prisma.curriculumNode.delete({ where: { id: request.params.id } });
      return reply.code(204).send();
    },
  );
};

export default nodesRoutes;
