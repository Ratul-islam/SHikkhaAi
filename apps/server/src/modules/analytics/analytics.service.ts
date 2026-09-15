import type { FastifyInstance } from "fastify";
import type {
  AnalyticsQuery,
  AnalyticsResponse,
  NodePassRate,
  StudentDrilldownResponse,
  UncoveredChapter,
  WeakTopic,
} from "./analytics.schema";

const WEAK_TOPICS_LIMIT = 10;

export class StudentNotFoundError extends Error {}

export async function getAnalytics(app: FastifyInstance, query: AnalyticsQuery): Promise<AnalyticsResponse> {
  // Cohort filter (Phase 3 §3.1) — applied at the CurriculumNode level, then
  // every downstream group-by is scoped to nodeId IN that set, so
  // classLevel/subject filtering is consistent across every panel rather
  // than each computing its own ad-hoc WHERE.
  const cohortNodes = await app.prisma.curriculumNode.findMany({
    where: {
      ...(query.classLevel ? { classLevel: query.classLevel } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
    },
    select: { id: true, title: true, subject: true, classLevel: true, chapterNumber: true },
  });
  const cohortNodeIds = cohortNodes.map((n) => n.id);
  const nodeById = new Map(cohortNodes.map((n) => [n.id, n]));
  const scoped = cohortNodeIds.length > 0 ? { nodeId: { in: cohortNodeIds } } : {};

  const [studentCount, documentChunkCount, weakGroups, masteryGroups] = await Promise.all([
    app.prisma.user.count({ where: { role: "STUDENT" } }),
    app.prisma.documentChunk.count(),
    app.prisma.userProgress.groupBy({
      by: ["nodeId"],
      where: scoped,
      _avg: { score: true },
      _count: { nodeId: true },
      orderBy: { _avg: { score: "asc" } },
      take: WEAK_TOPICS_LIMIT,
    }),
    app.prisma.masteryAttempt.groupBy({
      by: ["nodeId", "passed"],
      where: { ...scoped, submittedAt: { not: null } },
      _count: { nodeId: true },
    }),
  ]);

  const weakTopics: WeakTopic[] = weakGroups
    .map((g) => {
      const node = nodeById.get(g.nodeId);
      if (!node) return null;
      return {
        nodeId: g.nodeId,
        title: node.title,
        subject: node.subject,
        classLevel: node.classLevel,
        averageScore: g._avg.score ?? 0,
        attempts: g._count.nodeId,
      };
    })
    .filter((t): t is WeakTopic => t !== null);

  // Fold masteryGroups (grouped by nodeId AND passed) into a per-node pass rate.
  const byNode = new Map<string, { total: number; passed: number }>();
  for (const g of masteryGroups) {
    const entry = byNode.get(g.nodeId) ?? { total: 0, passed: 0 };
    entry.total += g._count.nodeId;
    if (g.passed) entry.passed += g._count.nodeId;
    byNode.set(g.nodeId, entry);
  }
  const nodePassRates: NodePassRate[] = [...byNode.entries()]
    .map(([nodeId, { total, passed }]) => {
      const node = nodeById.get(nodeId);
      if (!node) return null;
      return {
        nodeId,
        title: node.title,
        subject: node.subject,
        classLevel: node.classLevel,
        chapterNumber: node.chapterNumber,
        attempts: total,
        passRate: Math.round((passed / total) * 100),
      };
    })
    .filter((r): r is NodePassRate => r !== null)
    .sort((a, b) => a.passRate - b.passRate); // worst-performing levels first — the ones worth an admin's attention

  const uncoveredChapters = await getUncoveredChapters(app, query);

  return { studentCount, documentChunkCount, weakTopics, nodePassRates, uncoveredChapters };
}

/**
 * Chapters with ingested DocumentChunks but zero CurriculumNodes — directly
 * useful to the admin's Level Synthesis panel (Phase 1): "you've uploaded
 * this but never generated levels for it."
 */
async function getUncoveredChapters(app: FastifyInstance, query: AnalyticsQuery): Promise<UncoveredChapter[]> {
  const chunkGroups = await app.prisma.documentChunk.groupBy({
    by: ["classLevel", "subject", "chapter"],
    where: {
      ...(query.classLevel ? { classLevel: query.classLevel } : {}),
      ...(query.subject ? { subject: query.subject } : {}),
    },
    _count: { _all: true },
  });

  const nodeCoverage = await app.prisma.curriculumNode.findMany({
    select: { classLevel: true, subject: true, chapterNumber: true },
  });
  const covered = new Set(nodeCoverage.map((n) => `${n.classLevel}::${n.subject}::${n.chapterNumber}`));

  return chunkGroups
    .filter((g) => !covered.has(`${g.classLevel}::${g.subject}::${g.chapter}`))
    .map((g) => ({ classLevel: g.classLevel, subject: g.subject, chapter: g.chapter, chunkCount: g._count._all }));
}

export interface StudentListItem {
  id: string;
  name: string;
  email: string;
  classLevel: number;
  xp: number;
}

/** GET /admin/analytics/students — feeds the admin UI's picker for the drilldown below. */
export async function listStudents(app: FastifyInstance): Promise<StudentListItem[]> {
  const users = await app.prisma.user.findMany({
    where: { role: "STUDENT" },
    select: { id: true, name: true, email: true, classLevel: true, xp: true },
    orderBy: { name: "asc" },
  });
  return users;
}

/** GET /admin/analytics/students/:userId — Phase 3 §3.1's per-student drilldown. */
export async function getStudentDrilldown(app: FastifyInstance, userId: string): Promise<StudentDrilldownResponse> {
  const user = await app.prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new StudentNotFoundError(`User ${userId} not found`);

  const [profile, progressRows, attempts] = await Promise.all([
    app.prisma.userProfile.upsert({ where: { userId }, create: { userId }, update: {} }),
    app.prisma.userProgress.findMany({ where: { userId }, include: { node: true }, orderBy: { completedAt: "desc" } }),
    app.prisma.masteryAttempt.findMany({
      where: { userId },
      include: { node: true },
      orderBy: { startedAt: "desc" },
      take: 50,
    }),
  ]);

  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    classLevel: user.classLevel,
    xp: user.xp,
    streakDays: user.streakDays,
    profile: {
      visualPreferenceScore: profile.visualPreferenceScore,
      mathRigidityScore: profile.mathRigidityScore,
      patienceLevel: profile.patienceLevel,
      languageMix: profile.languageMix,
      weakTopics: profile.weakTopics,
    },
    progress: progressRows.map((p) => ({
      nodeId: p.nodeId,
      nodeTitle: p.node.title,
      classLevel: p.node.classLevel,
      subject: p.node.subject,
      status: p.status,
      score: p.score,
      completedAt: p.completedAt?.toISOString() ?? null,
    })),
    masteryHistory: attempts.map((a) => ({
      attemptId: a.id,
      nodeId: a.nodeId,
      nodeTitle: a.node.title,
      score: a.score,
      passed: a.passed,
      startedAt: a.startedAt.toISOString(),
      submittedAt: a.submittedAt?.toISOString() ?? null,
    })),
  };
}
