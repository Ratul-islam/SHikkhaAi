export interface SynthesizeLevelsBody {
  classLevel: number;
  subject: string;
  chapter: number;
}

/**
 * One proposed roadmap level, as returned for admin review.
 *
 * Prerequisites are `tempKey` references rather than UUIDs: nothing is
 * persisted at draft time, so the real node ids don't exist yet. The bulk
 * commit endpoint resolves them (see nodes.routes.ts).
 */
export interface DraftLevel {
  tempKey: string;
  title: string;
  description: string;
  orderIndex: number;
  prerequisiteKeys: string[];
  totalXp: number;
  sourcePages: number[];
}

export interface SynthesizeLevelsResponse {
  classLevel: number;
  subject: string;
  chapter: number;
  /** Chunks the draft was synthesized from — 0 means the chapter isn't ingested yet. */
  chunksAnalyzed: number;
  /** How many CurriculumNodes already exist for this triple, so the admin can see they're about to duplicate. */
  existingNodeCount: number;
  draft: DraftLevel[];
}

export interface ErrorResponse {
  error: string;
}

export const synthesizeLevelsBodySchema = {
  type: "object",
  required: ["classLevel", "subject", "chapter"],
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string", minLength: 1 },
    chapter: { type: "integer", minimum: 1 },
  },
} as const;

/** Structured-output contract for the reduce step. */
export const SYNTHESIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    levels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          tempKey: { type: "string" },
          title: { type: "string" },
          description: { type: "string" },
          prerequisiteKeys: { type: "array", items: { type: "string" } },
          sourcePages: { type: "array", items: { type: "integer" } },
        },
        required: ["tempKey", "title", "description", "prerequisiteKeys"],
      },
    },
  },
  required: ["levels"],
} as const;
