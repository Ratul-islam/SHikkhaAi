export interface ErrorResponse {
  error: string;
}

/* ── Whole-book ingestion jobs ───────────────────────────────────────────── */

export type IngestionJobStatus = "QUEUED" | "READING" | "READY_FOR_REVIEW" | "COMMITTING" | "COMMITTED" | "FAILED";

export interface CreateIngestionJobFields {
  classLevel: number;
  subject: string;
}

/** Multipart fields for POST /admin/ingestion/jobs — validated by hand, since multipart bodies bypass Fastify's JSON Schema. */
export function parseCreateIngestionJobFields(raw: Record<string, string | undefined>): CreateIngestionJobFields | null {
  const classLevel = Number(raw.classLevel);
  const subject = raw.subject?.trim();
  if (!subject || subject.length > 100 || !Number.isInteger(classLevel) || classLevel < 1 || classLevel > 12) return null;
  return { classLevel, subject };
}

export interface IngestionJobSummary {
  id: string;
  fileName: string;
  classLevel: number;
  subject: string;
  status: IngestionJobStatus;
  pageCount: number;
  pagesDone: number;
  pagesFailed: number;
  costUsd: number;
  chunksInserted: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface DraftTopic {
  code: string;
  title: string;
  startPage: number;
  endPage: number;
}

export interface DraftChapter {
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  topics: DraftTopic[];
}

export interface DraftStructure {
  chapters: DraftChapter[];
  /** Things the detector couldn't settle on its own — shown to the admin, never silently resolved. */
  warnings: string[];
}

export interface CommittedChapterSummary {
  id: string;
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  topicCount: number;
  chunkCount: number;
}

export interface IngestionJobDetailResponse {
  job: IngestionJobSummary;
  /** Detected from the pages read so far; null until reading has started. */
  draft: DraftStructure | null;
  failedPages: number[];
  /** Index = page - 1: the page's kind once read ("failed" if unreadable), null while it's still waiting. Drives the admin page map. */
  pageKinds: (string | null)[];
  committedChapters: CommittedChapterSummary[];
  /** False once the job is committed (the stored PDF is deleted then), so page images can't be rendered. */
  pdfAvailable: boolean;
}

export interface IngestionJobListResponse {
  jobs: IngestionJobSummary[];
}

export interface CreateIngestionJobResponse {
  job: IngestionJobSummary;
}

export interface IngestionPageView {
  pageNumber: number;
  pageKind: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  runningHeader: string;
  printedPageNumber: number | null;
  headings: { code: string; title: string }[];
  text: string;
  error: string | null;
}

export interface JobParams {
  id: string;
}

export interface JobPageParams {
  id: string;
  pageNumber: number;
}

export interface CommitIngestionJobBody {
  chapters: DraftChapter[];
}

export interface ChapterTopicView {
  id: string;
  code: string;
  title: string;
  startPage: number;
  endPage: number;
}

export interface ChapterView {
  id: string;
  classLevel: number;
  subject: string;
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  jobId: string | null;
  chunkCount: number;
  topics: ChapterTopicView[];
}

export interface ChapterListQuery {
  classLevel?: number;
  subject?: string;
}

export interface ChapterListResponse {
  chapters: ChapterView[];
}

export interface ChapterParams {
  id: string;
}

export const jobParamsSchema = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string", format: "uuid" } },
} as const;

export const jobPageParamsSchema = {
  type: "object",
  required: ["id", "pageNumber"],
  properties: {
    id: { type: "string", format: "uuid" },
    pageNumber: { type: "integer", minimum: 1 },
  },
} as const;

export const chapterParamsSchema = jobParamsSchema;

export const chapterListQuerySchema = {
  type: "object",
  properties: {
    classLevel: { type: "integer", minimum: 1, maximum: 12 },
    subject: { type: "string", minLength: 1 },
  },
} as const;

const draftTopicSchema = {
  type: "object",
  required: ["code", "title", "startPage", "endPage"],
  properties: {
    code: { type: "string", minLength: 1, maxLength: 20 },
    title: { type: "string", minLength: 1, maxLength: 300 },
    startPage: { type: "integer", minimum: 1 },
    endPage: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

export const commitIngestionJobBodySchema = {
  type: "object",
  required: ["chapters"],
  properties: {
    chapters: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        required: ["number", "title", "startPage", "endPage", "topics"],
        properties: {
          number: { type: "integer", minimum: 1 },
          title: { type: "string", minLength: 1, maxLength: 300 },
          startPage: { type: "integer", minimum: 1 },
          endPage: { type: "integer", minimum: 1 },
          topics: { type: "array", maxItems: 200, items: draftTopicSchema },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;
