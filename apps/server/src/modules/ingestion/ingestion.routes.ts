import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { authenticate, requireAdmin } from "../auth/auth.hooks";
import {
  InvalidPdfError,
  JobNotFoundError,
  JobStateError,
  StructureInvalidError,
  commitJob,
  createJob,
  deleteChapter,
  deleteJob,
  getJobDetail,
  getPage,
  listChapters,
  listJobs,
  renderPagePreview,
  resumeInterruptedJobs,
  retryFailedPages,
} from "./ingestion-job.service";
import {
  chapterListQuerySchema,
  chapterParamsSchema,
  commitIngestionJobBodySchema,
  jobPageParamsSchema,
  jobParamsSchema,
  parseCreateIngestionJobFields,
  type ChapterListQuery,
  type ChapterListResponse,
  type ChapterParams,
  type CommitIngestionJobBody,
  type CreateIngestionJobResponse,
  type ErrorResponse,
  type IngestionJobDetailResponse,
  type IngestionJobListResponse,
  type IngestionJobSummary,
  type IngestionPageView,
  type JobPageParams,
  type JobParams,
} from "./ingestion.schema";
import { MAX_PDF_BYTES } from "../../plugins/multipart";

const ADMIN = [authenticate, requireAdmin];

/**
 * Drains the multipart file, then reads its trailing form fields. The order is
 * load-bearing: @fastify/multipart only finishes parsing the fields after the
 * file part as the stream is consumed, so reading `.fields` first sees them empty.
 */
async function readPdfUpload(
  file: MultipartFile,
): Promise<{ buffer: Buffer; fields: Record<string, string | undefined> } | { error: string; code: number }> {
  if (file.mimetype !== "application/pdf") return { error: "Uploaded file must be a PDF", code: 400 };
  const buffer = await file.toBuffer();
  if (buffer.byteLength > MAX_PDF_BYTES) return { error: "PDF exceeds maximum upload size (100MB)", code: 413 };

  const fields: Record<string, string | undefined> = {};
  for (const [key, field] of Object.entries(file.fields)) {
    if (field && !Array.isArray(field) && field.type === "field") fields[key] = String(field.value);
  }
  return { buffer, fields };
}

/** Maps the job service's typed errors onto status codes; anything else is a logged 500. */
function sendJobError(request: FastifyRequest, reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof JobNotFoundError) return reply.code(404).send({ error: err.message });
  if (err instanceof JobStateError) return reply.code(409).send({ error: err.message });
  if (err instanceof StructureInvalidError || err instanceof InvalidPdfError) return reply.code(400).send({ error: err.message });
  request.log.error(err, "Ingestion request failed");
  return reply.code(500).send({ error: "Something went wrong with this book" });
}

const ingestionRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("onReady", async () => {
    await resumeInterruptedJobs(app).catch((err: unknown) => app.log.error(err, "Couldn't resume ingestion jobs"));
  });

  /** Uploads a whole book and starts reading it in the background. Returns at once — poll the job. */
  app.post<{ Reply: CreateIngestionJobResponse | ErrorResponse }>(
    "/ingestion/jobs",
    { preHandler: ADMIN },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "No file uploaded (expected a multipart 'file' field)" });

      const upload = await readPdfUpload(file);
      if ("error" in upload) return reply.code(upload.code).send({ error: upload.error });

      const fields = parseCreateIngestionJobFields(upload.fields);
      if (!fields) return reply.code(400).send({ error: "Missing/invalid fields: classLevel (1-12) and subject are required" });

      try {
        const job = await createJob(app, { fileName: file.filename, buffer: upload.buffer, ...fields });
        return reply.code(202).send({ job });
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  app.get<{ Reply: IngestionJobListResponse | ErrorResponse }>(
    "/ingestion/jobs",
    { preHandler: ADMIN },
    async (_request: FastifyRequest, reply: FastifyReply) => reply.send({ jobs: await listJobs(app) }),
  );

  app.get<{ Params: JobParams; Reply: IngestionJobDetailResponse | ErrorResponse }>(
    "/ingestion/jobs/:id",
    { preHandler: ADMIN, schema: { params: jobParamsSchema } },
    async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
      try {
        return reply.send(await getJobDetail(app, request.params.id));
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  app.get<{ Params: JobPageParams; Reply: IngestionPageView | ErrorResponse }>(
    "/ingestion/jobs/:id/pages/:pageNumber",
    { preHandler: ADMIN, schema: { params: jobPageParamsSchema } },
    async (request: FastifyRequest<{ Params: JobPageParams }>, reply: FastifyReply) => {
      try {
        return reply.send(await getPage(app, request.params.id, request.params.pageNumber));
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  app.get<{ Params: JobPageParams }>(
    "/ingestion/jobs/:id/pages/:pageNumber/image",
    { preHandler: ADMIN, schema: { params: jobPageParamsSchema } },
    async (request: FastifyRequest<{ Params: JobPageParams }>, reply: FastifyReply) => {
      try {
        const png = await renderPagePreview(app, request.params.id, request.params.pageNumber);
        return reply.type("image/png").header("Cache-Control", "private, max-age=3600").send(png);
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  app.post<{ Params: JobParams; Reply: { job: IngestionJobSummary } | ErrorResponse }>(
    "/ingestion/jobs/:id/retry-failed",
    { preHandler: ADMIN, schema: { params: jobParamsSchema } },
    async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
      try {
        return reply.code(202).send({ job: await retryFailedPages(app, request.params.id) });
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  /** Persists the admin-reviewed structure. Runs in the background; poll the job for COMMITTED. */
  app.post<{ Params: JobParams; Body: CommitIngestionJobBody; Reply: { job: IngestionJobSummary } | ErrorResponse }>(
    "/ingestion/jobs/:id/commit",
    { preHandler: ADMIN, schema: { params: jobParamsSchema, body: commitIngestionJobBodySchema } },
    async (request: FastifyRequest<{ Params: JobParams; Body: CommitIngestionJobBody }>, reply: FastifyReply) => {
      try {
        return reply.code(202).send({ job: await commitJob(app, request.params.id, request.body.chapters) });
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  app.delete<{ Params: JobParams; Reply: ErrorResponse | undefined }>(
    "/ingestion/jobs/:id",
    { preHandler: ADMIN, schema: { params: jobParamsSchema } },
    async (request: FastifyRequest<{ Params: JobParams }>, reply: FastifyReply) => {
      try {
        await deleteJob(app, request.params.id);
        return reply.code(204).send();
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );

  app.get<{ Querystring: ChapterListQuery; Reply: ChapterListResponse | ErrorResponse }>(
    "/ingestion/chapters",
    { preHandler: ADMIN, schema: { querystring: chapterListQuerySchema } },
    async (request: FastifyRequest<{ Querystring: ChapterListQuery }>, reply: FastifyReply) =>
      reply.send({ chapters: await listChapters(app, request.query) }),
  );

  app.delete<{ Params: ChapterParams; Reply: ErrorResponse | undefined }>(
    "/ingestion/chapters/:id",
    { preHandler: ADMIN, schema: { params: chapterParamsSchema } },
    async (request: FastifyRequest<{ Params: ChapterParams }>, reply: FastifyReply) => {
      try {
        await deleteChapter(app, request.params.id);
        return reply.code(204).send();
      } catch (err) {
        return sendJobError(request, reply, err);
      }
    },
  );
};

export default ingestionRoutes;
