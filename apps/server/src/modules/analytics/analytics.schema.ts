export interface WeakTopic {
  nodeId: string;
  title: string;
  subject: string;
  classLevel: number;
  averageScore: number;
  attempts: number;
}

/** Phase 3 §3.1 — surfaces levels that are too hard, or badly synthesized, for the admin reviewing Level Synthesis drafts. */
export interface NodePassRate {
  nodeId: string;
  title: string;
  subject: string;
  classLevel: number;
  chapterNumber: number;
  attempts: number;
  passRate: number; // 0-100
}

/** A chapter with ingested textbook content but no CurriculumNode yet — directly actionable from the admin's Level Synthesis panel. */
export interface UncoveredChapter {
  classLevel: number;
  subject: string;
  chapter: number;
  chunkCount: number;
}

export interface AnalyticsResponse {
  studentCount: number;
  documentChunkCount: number;
  weakTopics: WeakTopic[];
  nodePassRates: NodePassRate[];
  uncoveredChapters: UncoveredChapter[];
}

export interface AnalyticsQuery {
  classLevel?: number;
  subject?: string;
}

export const analyticsQuerySchema = {
  type: "object",
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string", minLength: 1 },
  },
} as const;

/** GET /admin/analytics/students/:userId */
export interface StudentDrilldownResponse {
  userId: string;
  name: string;
  email: string;
  classLevel: number;
  xp: number;
  streakDays: number;
  profile: {
    visualPreferenceScore: number;
    mathRigidityScore: number;
    patienceLevel: number;
    languageMix: string;
    weakTopics: string[];
  };
  progress: {
    nodeId: string;
    nodeTitle: string;
    classLevel: number;
    subject: string;
    status: string;
    score: number;
    completedAt: string | null;
  }[];
  masteryHistory: {
    attemptId: string;
    nodeId: string;
    nodeTitle: string;
    score: number | null;
    passed: boolean | null;
    startedAt: string;
    submittedAt: string | null;
  }[];
}

export interface ErrorResponse {
  error: string;
}
