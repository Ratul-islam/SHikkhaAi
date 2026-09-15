import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { authenticate } from "../auth/auth.hooks";
import { synthesizeNarration } from "../speech/edge-speech.service";
import { findCachedNarration, startNarrationInBackground } from "../speech/gemini-speech.service";
import { env, isGeminiTtsConfigured } from "../../config/env";
import { alignCues } from "./cue-align.service";
import { resolveSceneIds } from "../chat/orchestrator";
import { buildOrGetLesson } from "./lesson-build.service";
import { recordSpend } from "./library.service";
import { parseVideoBrief } from "./director.schema";
import {
  videoBuildBodySchema,
  type ErrorResponse,
  type VideoBuildRequestBody,
  type VideoLessonResponse,
} from "./video.schema";

/**
 * Builds the audio-visual layer of a VIDEO turn.
 *
 * NEVER blocks on generation (CLAUDE.md, learned the hard way): a full build is
 * ~90s cold, and the Next dev rewrite cuts a request at exactly 30s with a
 * bare, non-JSON 500 — which is why video silently never appeared in the
 * browser while working perfectly against :4000. The route returns
 * `generating: true` and the client polls; lesson-build.service dedupes the
 * repeat requests that produces so nothing is built or billed twice.
 *
 * Two paths, chosen by what the body carries (PLAN.md §12):
 *  - `videoBrief`  → the current pipeline.
 *  - `videoScript` → a turn stored before it existed, replayed as it always was.
 */

/* ── Legacy replay ──────────────────────────────────────────────────────────
 * Kept because stored history carries the old shape, and losing it would
 * repeat a bug this codebase has already had once. It is unchanged except in
 * one respect: there is no footage any more, and with it goes the `footageMs`
 * offset that used to shift every drawn scene a whole reel-length out of step
 * with its own narration. Old videos therefore replay BETTER than they played
 * when they were new.
 */
async function replayLegacyScript(
  app: FastifyInstance,
  userId: string,
  body: VideoBuildRequestBody,
): Promise<VideoLessonResponse> {
  const videoScript = body.videoScript!;

  let audioUrl = "";
  let timestamps: { word: string; startMs: number; endMs: number }[] = [];
  let generating = false;

  if (isGeminiTtsConfigured()) {
    const cached = await findCachedNarration(videoScript.narration);
    if (cached) {
      audioUrl = cached.audioUrl;
      timestamps = cached.timestamps;
    } else {
      startNarrationInBackground(videoScript.narration, {
        onDone: (costUsd) =>
          void recordSpend(app, { userId, kind: "TTS", model: env.TTS_MODEL, costUsd }).catch((err) =>
            app.log.error(err, "Failed to record TTS spend"),
          ),
        onError: (err) => app.log.error(err, "Background legacy narration failed"),
      });
      generating = true;
    }
  } else {
    const result = await synthesizeNarration(videoScript.narration, videoScript.accentLocale);
    audioUrl = result.audioUrl;
    timestamps = result.timestamps;
  }

  const alignedScript = {
    ...videoScript,
    visualCues: resolveSceneIds(alignCues(videoScript.visualCues, timestamps)),
  };

  return {
    title: videoScript.title,
    scenes: [],
    totalDurationMs: timestamps.at(-1)?.endMs ?? 0,
    timestampManifest: timestamps,
    generating,
    reused: false,
    videoScript: alignedScript,
    audioUrl,
  };
}

const videoRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post<{ Body: VideoBuildRequestBody; Reply: VideoLessonResponse | ErrorResponse }>(
    "/build",
    { preHandler: authenticate, schema: { body: videoBuildBodySchema } },
    async (request: FastifyRequest<{ Body: VideoBuildRequestBody }>, reply: FastifyReply) => {
      try {
        const { subject, chapter, nodeId, wantsNewVariant } = request.body;
        const userId = request.user.userId;

        // Legacy first: a body carrying a stored script is unambiguous, and
        // routing it anywhere else would silently re-bill a lesson that has
        // already been made.
        if (request.body.videoScript?.visualCues) {
          return reply.send(await replayLegacyScript(app, userId, request.body));
        }

        const brief = parseVideoBrief(request.body.videoBrief);
        if (!brief) {
          return reply.code(400).send({ error: "A videoBrief or a legacy videoScript is required" });
        }
        if (!subject || !chapter) {
          // Not pedantry — these are the grade-isolation triple (guardrail #4),
          // and retrieval, the library and the reuse key all key on them.
          return reply.code(400).send({ error: "subject and chapter are required to build a lesson" });
        }

        const user = await app.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const profile = await app.prisma.userProfile.findUnique({ where: { userId } });

        const result = await buildOrGetLesson(app, {
          userId,
          classLevel: user.classLevel,
          subject,
          chapter,
          nodeId: nodeId ?? null,
          brief,
          weakTopics: profile?.weakTopics ?? [],
          ...(wantsNewVariant !== undefined ? { wantsNewVariant } : {}),
        });

        if (!result.lesson) {
          return reply.send({
            title: brief.title,
            scenes: [],
            totalDurationMs: 0,
            timestampManifest: [],
            generating: result.generating,
            reused: false,
            ...(result.failed ? { failed: result.failed } : {}),
          });
        }

        const { lesson } = result;
        return reply.send({
          title: lesson.title,
          scenes: lesson.scenes,
          ...(lesson.lessonUrl ? { lessonUrl: lesson.lessonUrl } : {}),
          totalDurationMs: lesson.totalDurationMs,
          timestampManifest: lesson.timestampManifest,
          generating: false,
          reused: lesson.reused,
        });
      } catch (err) {
        request.log.error(err, "Video lesson build failed");
        return reply.code(500).send({ error: "Failed to build the video lesson" });
      }
    },
  );
};

export default videoRoutes;
