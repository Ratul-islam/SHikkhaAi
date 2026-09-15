import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireVerified } from "../auth/auth.hooks";
import { CHAT_RATE_LIMIT } from "../../plugins/rateLimit";
import { generateChatReply } from "./chat.service";
import { listIngestedChapters } from "../../lib/vectorSearch";
import {
  chatBodySchema,
  type ChatChapterOption,
  type ChatRequestBody,
  type ChatResponse,
  type ChatTopicsResponse,
  type ErrorResponse,
} from "./chat.schema";
import {
  listConversations,
  loadHistory,
  type ChatMessageRecord,
  type ConversationSummary,
} from "./history.service";

/**
 * Every chapter a student can ask about, chapter-first with its topics.
 *
 * Committed textbook chapters (whole-book ingestion) come with their real
 * titles and topics. Two older sources are still unioned in so nothing that
 * was askable disappears: chapters known only from roadmap levels, and chunks
 * from the legacy single-chapter upload, which have no Chapter row.
 */
async function listChatTopics(app: FastifyInstance, classLevel: number): Promise<ChatChapterOption[]> {
  const [chapters, nodes, ingested] = await Promise.all([
    app.prisma.chapter.findMany({
      where: { classLevel },
      include: { topics: { orderBy: { orderIndex: "asc" }, select: { id: true, code: true, title: true } } },
    }),
    app.prisma.curriculumNode.findMany({
      where: { classLevel },
      orderBy: { orderIndex: "asc" },
      select: { subject: true, chapterNumber: true, title: true },
    }),
    listIngestedChapters(app, classLevel),
  ]);

  const byKey = new Map<string, ChatChapterOption>();
  for (const c of chapters) {
    byKey.set(`${c.subject}::${c.number}`, { subject: c.subject, chapter: c.number, title: c.title, topics: c.topics });
  }
  // Nodes come lowest-orderIndex first, so the first one seen is the chapter's entry-point title.
  for (const n of nodes) {
    const key = `${n.subject}::${n.chapterNumber}`;
    if (!byKey.has(key)) byKey.set(key, { subject: n.subject, chapter: n.chapterNumber, title: n.title, topics: [] });
  }
  for (const c of ingested) {
    const key = `${c.subject}::${c.chapter}`;
    if (!byKey.has(key)) byKey.set(key, { subject: c.subject, chapter: c.chapter, title: null, topics: [] });
  }

  return Array.from(byKey.values()).sort((a, b) => a.subject.localeCompare(b.subject) || a.chapter - b.chapter);
}

interface HistoryQuery {
  subject: string;
  chapter: string;
  conversationSlot?: string;
}

const historyQuerySchema = {
  type: "object",
  required: ["subject", "chapter"],
  properties: {
    subject: { type: "string", minLength: 1 },
    chapter: { type: "string", pattern: "^[0-9]+$" },
    conversationSlot: { type: "string", pattern: "^[0-9]+$" },
  },
} as const;

const chatRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: ChatRequestBody; Reply: ChatResponse | ErrorResponse }>(
    "/",
    { preHandler: [authenticate, requireVerified], schema: { body: chatBodySchema }, config: { rateLimit: CHAT_RATE_LIMIT } },
    async (request: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      try {
        const result = await generateChatReply(app, request.user.userId, request.body);
        return reply.send(result);
      } catch (err) {
        request.log.error(err, "Chat completion failed");
        return reply.code(500).send({ error: "Failed to generate a response" });
      }
    },
  );

  /**
   * Server-Sent Events version of the route above — same
   * `generateChatReply`, same rate limit, same everything, just narrated:
   * a real `stage` event as each actual async step starts (retrieval, the
   * model call, persistence), then one `final` event carrying the exact
   * same `ChatResponse` the non-streaming route returns.
   *
   * Deliberately not token-level streaming of the model's own output: the
   * response is structured JSON (`response_format: json_schema` in
   * orchestrator.ts) that decides responseType/videoScript/content
   * together — streaming raw partial JSON through that contract reliably
   * isn't something this provider's compatibility layer can promise (see
   * lib/openai.ts's own notes on quota/compatibility quirks). The frontend
   * gets its "watch it type" feel from a client-side reveal of the
   * complete `content` once `final` arrives instead — real progress
   * before that point, a smooth reveal after.
   */
  app.post<{ Body: ChatRequestBody }>(
    "/stream",
    { preHandler: [authenticate, requireVerified], schema: { body: chatBodySchema }, config: { rateLimit: CHAT_RATE_LIMIT } },
    async (request: FastifyRequest<{ Body: ChatRequestBody }>, reply: FastifyReply) => {
      reply.hijack(); // taking the response lifecycle over manually from here
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      });

      const send = (event: string, data: unknown): void => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        const result = await generateChatReply(app, request.user.userId, request.body, (stage) =>
          send("stage", { stage }),
        );
        send("final", result);
      } catch (err) {
        request.log.error(err, "Streaming chat completion failed");
        send("error", { error: "Failed to generate a response" });
      } finally {
        reply.raw.end();
      }
    },
  );

  /** Hydrates the /chat page on load — replaces the old client-held history. */
  app.get<{ Querystring: HistoryQuery; Reply: { messages: ChatMessageRecord[] } | ErrorResponse }>(
    "/history",
    { preHandler: authenticate, schema: { querystring: historyQuerySchema } },
    async (request: FastifyRequest<{ Querystring: HistoryQuery }>, reply: FastifyReply) => {
      const chapter = Number(request.query.chapter);
      const conversationSlot = request.query.conversationSlot ? Number(request.query.conversationSlot) : undefined;
      const messages = await loadHistory(app, request.user.userId, request.query.subject, chapter, conversationSlot);
      return reply.send({ messages });
    },
  );

  /** Feeds the chat chapter/topic picker. Grade comes from the token, never the query, so a student only ever sees their own class's chapters. */
  app.get<{ Reply: ChatTopicsResponse | ErrorResponse }>(
    "/topics",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const chapters = await listChatTopics(app, request.user.classLevel);
      return reply.send({ chapters });
    },
  );

  /** Feeds the chat sidebar's conversation list. */
  app.get<{ Reply: { conversations: ConversationSummary[] } | ErrorResponse }>(
    "/conversations",
    { preHandler: authenticate },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const conversations = await listConversations(app, request.user.userId);
      return reply.send({ conversations });
    },
  );
};

export default chatRoutes;
