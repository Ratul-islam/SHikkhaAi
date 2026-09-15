import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate, requireVerified } from "../auth/auth.hooks";
import { CHAT_RATE_LIMIT } from "../../plugins/rateLimit";
import { chatClient, CHAT_MODEL, embedText } from "../../lib/openai";
import { searchDocumentChunks } from "../../lib/vectorSearch";
import { PERSONA_DESCRIPTION, buildContextBlock, buildProfileHints } from "./prompt";

export interface TimestampAskRequestBody {
  /** Opaque client-supplied correlation id — there's no persisted "video" row to look up (synthesis is synchronous/ephemeral), this is for logging only. */
  videoId: string;
  timestampMs: number;
  spokenSentence: string;
  userQuestion: string;
  /**
   * PLAN.md Phase 2 §2.5: added so this endpoint can actually ground its
   * answer in the textbook, like every other student-facing path already
   * does — before this, it was the one path answering from persona alone.
   */
  subject: string;
  chapter: number;
}

export interface TimestampAskResponse {
  explanation: string;
}

export interface ErrorResponse {
  error: string;
}

export const timestampAskBodySchema = {
  type: "object",
  required: ["videoId", "timestampMs", "spokenSentence", "userQuestion", "subject", "chapter"],
  properties: {
    videoId: { type: "string", minLength: 1 },
    timestampMs: { type: "number", minimum: 0 },
    spokenSentence: { type: "string", minLength: 1 },
    userQuestion: { type: "string", minLength: 1 },
    subject: { type: "string", minLength: 1 },
    chapter: { type: "integer", minimum: 1 },
  },
} as const;

// Mounted under the same "/api/v1/chat" prefix as chat.routes.ts (see app.ts)
// so the final path is POST /api/v1/chat/timestamp-ask, but kept as its own
// plugin/file since it's a distinct, focused capability — not a new curriculum
// question, just "explain the sentence I just paused on, differently."
const timestampAskRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: TimestampAskRequestBody; Reply: TimestampAskResponse | ErrorResponse }>(
    "/timestamp-ask",
    { preHandler: [authenticate, requireVerified], schema: { body: timestampAskBodySchema }, config: { rateLimit: CHAT_RATE_LIMIT } },
    async (request: FastifyRequest<{ Body: TimestampAskRequestBody }>, reply: FastifyReply) => {
      try {
        const { timestampMs, spokenSentence, userQuestion, subject, chapter } = request.body;

        const [user, profile] = await Promise.all([
          app.prisma.user.findUniqueOrThrow({ where: { id: request.user.userId } }),
          app.prisma.userProfile.upsert({
            where: { userId: request.user.userId },
            create: { userId: request.user.userId },
            update: {},
          }),
        ]);

        // Retrieval query is the spoken sentence plus the student's actual
        // question — the sentence alone would just re-find the passage the
        // narration was already built from; the question is what picks out
        // whichever part of it is actually relevant to what confused them.
        const queryEmbedding = await embedText(`${spokenSentence} ${userQuestion}`);
        const matches = await searchDocumentChunks(app, {
          classLevel: user.classLevel,
          subject,
          chapter,
          queryEmbedding,
        });

        const systemPrompt = [
          PERSONA_DESCRIPTION,
          `The student paused a video lesson while you were saying: "${spokenSentence}" (around ${timestampMs}ms in). They're asking a follow-up about that specific moment, not starting a new topic — answer directly and briefly: two or three sentences plus one supporting analogy. This is a quick aside, not a full lesson.`,
          buildProfileHints(profile, profile.weakTopics ?? []),
          `NCTB textbook context:\n${buildContextBlock(matches.map((m) => m.content))}`,
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n\n");

        const completion = await chatClient.chat.completions.create({
          model: CHAT_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userQuestion },
          ],
        });

        return reply.send({ explanation: completion.choices[0]?.message?.content ?? "" });
      } catch (err) {
        request.log.error(err, "Timestamped re-explanation failed");
        return reply.code(500).send({ error: "Failed to generate an explanation" });
      }
    },
  );
};

export default timestampAskRoutes;
