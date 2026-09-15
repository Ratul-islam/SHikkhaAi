import type { FastifyInstance } from "fastify";
import { chatClient, CHAT_MODEL, embedText } from "../../lib/openai";
import { env } from "../../config/env";
import { searchDocumentChunks } from "../../lib/vectorSearch";
import { extractJsonPayload } from "../chat/orchestrator";
import {
  DIRECTED_SCRIPT_JSON_SCHEMA,
  isDirectedScript,
  parseDirectedScript,
  type DirectedScript,
  type VideoBrief,
} from "./director.schema";

/**
 * Stage [1] of the lesson pipeline (PLAN.md §3): turns the Orchestrator's short
 * brief into a full directed script — the teaching arc, and the scenes that
 * carry it.
 *
 * This is a second, focused model call rather than more fields on the
 * Orchestrator's already-enormous one. Three reasons, in order of how much they
 * matter:
 *
 *  1. It runs inside /video/build, which is already asynchronous and polled, so
 *     it adds NOTHING to the latency of the chat reply the student is reading.
 *  2. The Orchestrator's prompt carries persona, craft rules, personalization,
 *     the widget spec and the suggestion spec. Every line of video direction
 *     added there made the chat answer itself worse.
 *  3. This call can be handed the full retrieved NCTB context and asked for one
 *     thing only, which is the condition under which models write well.
 *
 * Cost is ~$0.001 per lesson, and it only runs on VIDEO turns.
 */

const DIRECTOR_SYSTEM_PROMPT = `You are the DIRECTOR of a short animated lesson for a Bangladeshi student, working from the NCTB curriculum. You are given a brief. You return the script that will actually be shot.

Your output is rendered by **Manim** — programmatic 2D animation. Everything you direct will be DRAWN: shapes, arrows, graphs, vectors, labels, equations, and numbers that change over time. Nothing is filmed. Direct accordingly: ask for a labelled force diagram, not "a shot of a cricket stadium".

THE ARC — \`approach\`
Write one paragraph on how this lesson teaches. Not a summary of the topic: an argument for why scene 1 earns scene 2. The strongest shape, and your default, is ONE PICTURE THAT TRANSFORMS — open on a concrete everyday thing the student already understands, then keep its layout, colours and positions recognisably the same while it becomes the real concept. The bowler's arm stands where the force arrow will stand. A lesson of three unrelated diagrams teaches far less than one picture that changes.

THE SCENES — \`scenes\`
2 to ${env.VIDEO_MAX_SCENES} scenes. Each one is a single continuous picture with narration spoken over it.

- \`narration\` — THE SPOKEN WORDS FOR THIS SCENE ONLY, in Bangla. This is read aloud by a real voice and its measured length becomes the scene's length, so write it to be HEARD: natural connected speech, no headings, no bullets, no markdown, no emoji, no "$" notation. Say equations the way a teacher says them out loud ("এফ সমান এম এ"). Aim for 2-5 sentences — roughly 25 to 60 words. A scene whose narration is one short clause gives the animation no time to breathe; one that runs past 60 words is really two scenes.
- \`visualBrief\` — direct the picture in full prose, to someone who will draw it and cannot ask you questions. Say what is on screen at the start, WHAT MOVES and how, and what it should look like at the end. Name positions ("the block sits left of centre, the arrow starts at its right edge"). Be specific about the mechanism: the ball accelerating, the current flowing round the loop, the mercury column dropping. If the picture would look identical at the start and the end, it is not teaching anything a still image could not.
- \`labels\` — the Bangla words that must appear on screen. Short: "বেগ", "ঘর্ষণ বল", "চাপ বাড়ছে".
- \`mathTex\` — equations and numerals as LaTeX fragments: "v = u + at", "F_{net} = 0", "10\\\\,\\\\text{m/s}". **NEVER put Bangla in here.** LaTeX cannot typeset Bengali at all; Bangla words belong in \`labels\`. This is not a style preference — a Bangla character in this field fails the render.
- \`carryOver\` — what the previous scene leaves on screen for this one to build on. Say it explicitly whenever it applies; it is how the transformation above actually happens.
- \`beats\` — 2 to 4 moments inside the scene. \`at\` is a FRACTION of this scene (0 = its first word, 1 = its last), \`highlightText\` is a short Bangla phrase spoken VERBATIM in this scene's narration at that moment, and \`focusX\`/\`focusY\` (0-1) say where in the picture that beat is talking about, so the camera can move there.
- \`role\` — HOOK, ANALOGY, MECHANISM, WORKED_EXAMPLE, MISCONCEPTION or RECAP.

SCOPE
You have up to ${env.VIDEO_MAX_TOTAL_SEC} seconds, which is enough to teach ONE concept properly. Use it to finish the idea, not to survey a chapter. If the brief is broader than that, narrow it to the single most useful thing and teach that completely.

GROUNDING
Stay inside the NCTB context you are given. Use its terminology and its notation. If the context does not cover something, do not invent curriculum — teach what is there.`;

function buildDirectorUserMessage(params: {
  brief: VideoBrief;
  classLevel: number;
  subject: string;
  chapter: number;
  contextChunks: string[];
  weakTopics: string[];
}): string {
  const { brief, classLevel, subject, chapter, contextChunks, weakTopics } = params;

  return [
    `Class ${classLevel} · ${subject} · Chapter ${chapter}`,
    `TITLE: ${brief.title}`,
    `CONCEPT: ${brief.conceptKey}`,
    `GOAL: ${brief.goal}`,
    brief.analogy ? `ANALOGY TO BUILD ON: ${brief.analogy}` : null,
    weakTopics.length > 0
      ? `This student has struggled with: ${weakTopics.join(", ")}. Slow down where the lesson touches these.`
      : null,
    "",
    "NCTB textbook context:",
    contextChunks.length > 0 ? contextChunks.map((chunk, i) => `[${i + 1}] ${chunk}`).join("\n\n") : "(none retrieved)",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export interface DirectParams {
  userId: string;
  classLevel: number;
  subject: string;
  chapter: number;
  brief: VideoBrief;
  weakTopics?: string[];
}

export interface DirectFailure {
  script: null;
  reason: string;
}

export interface DirectSuccess {
  script: DirectedScript;
  reason: null;
}

/**
 * Produces the directed script, or a reason it couldn't.
 *
 * Never throws. A failure here degrades the turn to TEXT (whose `content` the
 * Orchestrator prompt requires to be a genuine standalone explanation), which
 * is a real answer — so there is nothing to be gained by propagating.
 */
export async function directLesson(
  app: FastifyInstance,
  params: DirectParams,
): Promise<DirectSuccess | DirectFailure> {
  const { brief, classLevel, subject, chapter } = params;

  // Retrieval is grade-isolated by the same triple every other path uses
  // (guardrail #4) — the director must not be the one route that reads
  // content without it.
  let contextChunks: string[] = [];
  try {
    const queryEmbedding = await embedText(`${brief.title}. ${brief.goal}`);
    const matches = await searchDocumentChunks(app, { classLevel, subject, chapter, queryEmbedding });
    contextChunks = matches.map((m) => m.content);
  } catch (err) {
    // Retrieval failure degrades the script's grounding, not the lesson. The
    // embedding endpoint is still the daily-capped one (guardrail #7), so this
    // is a realistic path, not a theoretical one.
    app.log.error(err, "Director context retrieval failed — directing without NCTB grounding");
  }

  const userMessage = buildDirectorUserMessage({
    brief,
    classLevel,
    subject,
    chapter,
    contextChunks,
    weakTopics: params.weakTopics ?? [],
  });

  let raw: string;
  try {
    const completion = await chatClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: DIRECTOR_SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "directed_script", schema: DIRECTED_SCRIPT_JSON_SCHEMA },
      },
    });
    raw = completion.choices[0]?.message?.content ?? "";
  } catch (err) {
    app.log.error(err, "Director call failed");
    return { script: null, reason: "director call failed" };
  }

  if (!raw.trim()) return { script: null, reason: "director returned nothing" };

  let parsed: unknown;
  try {
    // Same unwrapping the orchestrator needs: models fence structured output
    // even when asked not to.
    parsed = JSON.parse(extractJsonPayload(raw));
  } catch (err) {
    app.log.error({ err, raw: raw.slice(0, 400) }, "Director output did not parse");
    return { script: null, reason: "director output did not parse" };
  }

  const result = parseDirectedScript(parsed);
  if (!isDirectedScript(result)) {
    app.log.warn({ reason: result.reason }, "Director output rejected");
    return { script: null, reason: result.reason };
  }

  // The brief's conceptKey is the library's reuse key and the Orchestrator
  // chose it with the student's own question in view; the director's is a
  // paraphrase. Prefer the brief's so two students asking the same thing
  // differently still land on the same shelf.
  return { script: { ...result, conceptKey: brief.conceptKey || result.conceptKey }, reason: null };
}
