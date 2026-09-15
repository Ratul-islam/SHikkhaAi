export interface CurriculumNodeView {
  id: string;
  classLevel: number;
  subject: string;
  chapterNumber: number;
  title: string;
  description: string;
  prerequisites: string[];
  orderIndex: number;
  totalXp: number;
  sourcePages: number[];
  synthesized: boolean;
}

export interface CreateNodeBody {
  classLevel: number;
  subject: string;
  chapterNumber: number;
  title: string;
  description: string;
  prerequisites: string[];
  orderIndex: number;
  totalXp?: number;
}

export interface UpdateNodeBody {
  classLevel?: number;
  subject?: string;
  chapterNumber?: number;
  title?: string;
  description?: string;
  prerequisites?: string[];
  orderIndex?: number;
  totalXp?: number;
}

export interface NodeListResponse {
  nodes: CurriculumNodeView[];
}

/** One reviewed level from a synthesis draft, ready to commit. Prerequisites are still tempKeys. */
export interface BulkNodeInput {
  tempKey: string;
  title: string;
  description: string;
  orderIndex: number;
  prerequisiteKeys: string[];
  totalXp?: number;
  sourcePages?: number[];
}

export interface BulkCreateNodesBody {
  classLevel: number;
  subject: string;
  chapterNumber: number;
  levels: BulkNodeInput[];
}

export interface BulkCreateNodesResponse {
  created: number;
  nodes: CurriculumNodeView[];
}

export interface ErrorResponse {
  error: string;
}

export const createNodeBodySchema = {
  type: "object",
  required: ["classLevel", "subject", "chapterNumber", "title", "description", "prerequisites", "orderIndex"],
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string", minLength: 1 },
    chapterNumber: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    prerequisites: { type: "array", items: { type: "string" } },
    orderIndex: { type: "integer" },
    totalXp: { type: "integer", minimum: 0 },
  },
} as const;

export const bulkCreateNodesBodySchema = {
  type: "object",
  required: ["classLevel", "subject", "chapterNumber", "levels"],
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string", minLength: 1 },
    chapterNumber: { type: "integer", minimum: 1 },
    levels: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["tempKey", "title", "description", "orderIndex", "prerequisiteKeys"],
        properties: {
          tempKey: { type: "string", minLength: 1 },
          title: { type: "string", minLength: 1 },
          description: { type: "string" },
          orderIndex: { type: "integer" },
          prerequisiteKeys: { type: "array", items: { type: "string" } },
          totalXp: { type: "integer", minimum: 0 },
          sourcePages: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
} as const;

export const updateNodeBodySchema = {
  type: "object",
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string", minLength: 1 },
    chapterNumber: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    description: { type: "string" },
    prerequisites: { type: "array", items: { type: "string" } },
    orderIndex: { type: "integer" },
    totalXp: { type: "integer", minimum: 0 },
  },
} as const;
