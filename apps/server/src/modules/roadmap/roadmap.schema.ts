export type NodeStatus = "LOCKED" | "UNLOCKED" | "COMPLETED";

export interface RoadmapNodeView {
  id: string;
  classLevel: number;
  subject: string;
  chapterNumber: number;
  title: string;
  description: string;
  prerequisites: string[];
  orderIndex: number;
  totalXp: number;
  status: NodeStatus;
  score: number | null;
}

export interface RoadmapResponse {
  nodes: RoadmapNodeView[];
}

export interface ErrorResponse {
  error: string;
}

export const roadmapQuerySchema = {
  type: "object",
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string" },
  },
} as const;

export interface RoadmapQuery {
  classLevel?: number;
  subject?: string;
}
