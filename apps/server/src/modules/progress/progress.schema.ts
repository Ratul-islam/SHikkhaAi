/**
 * NOTE: `score` is deliberately absent from the request body.
 *
 * It used to be client-supplied, and the only caller in the app hardcoded
 * `score: 100` — which meant every completed node recorded a perfect score and
 * both `computeWeakTopics()` and the admin weak-topics panel were aggregating a
 * constant. UserProgress.score is now written only by the Mastery Check's
 * server-side grader (see modules/mastery/mastery.service.ts).
 */
export interface CompleteProgressBody {
  nodeId: string;
}

export interface CompleteProgressResponse {
  nodeId: string;
  xpAwarded: number;
  totalXp: number;
  newlyUnlockedNodeIds: string[];
}

export interface ErrorResponse {
  error: string;
}

export const completeProgressBodySchema = {
  type: "object",
  required: ["nodeId"],
  properties: {
    nodeId: { type: "string", minLength: 1 },
  },
  // Rejects a stale client still POSTing { nodeId, score } rather than silently
  // ignoring the score it thinks it's setting.
  additionalProperties: false,
} as const;
