import type { FastifyInstance } from "fastify";
import type { UserProfile } from "@shikkha-ai/database";
import { chatClient, CHAT_MODEL, embedText } from "../../lib/openai";
import { env } from "../../config/env";
import { searchDocumentChunks } from "../../lib/vectorSearch";
import { buildStudyFocusLine } from "./prompt";
import { VIDEO_BRIEF_JSON_SCHEMA, parseVideoBrief, type VideoBrief } from "../video/director.schema";
import {
  PERSONA_DESCRIPTION,
  EXPLANATION_CRAFT_RULES,
  PERSONALIZATION_RULES,
  SCOPE_AND_GROUNDING_RULES,
  buildContextBlock,
  buildProfileHints,
  buildHistoryBlock,
  type ChatHistoryTurn,
  type LearningProfile,
} from "./prompt";

export interface VisualCue {
  timeMs: number;
  animationType: string;
  highlightText: string;
  /**
   * Phase 2 §2.3 — an optional self-contained HTML5 Canvas/SVG snippet for
   * this specific moment, the same capability CANVAS responses already
   * have, brought into VIDEO. Optional because most cues are a text beat,
   * not a diagram. Rendered through the exact same sandboxed-iframe
   * technique as VisualSandbox.tsx (`sandbox="allow-scripts"`, no
   * `allow-same-origin`) — this is model-generated markup, never trusted.
   *
   * This diagram ANIMATES, but only off the video's clock: it defines
   * `window.shikkhaRender(t)` (t = 0..1 across its scene) and draws itself as
   * a pure function of `t`, which LessonComposition calls every frame. That
   * purity is what makes pause, seek and rewind work.
   *
   * Self-running animation — CSS keyframes/transitions, setInterval,
   * requestAnimationFrame, Date.now() — remains forbidden, because it runs on
   * wall-clock time divorced from the timeline: it ignores pause, doesn't
   * rewind, and would render as garbage frames server-side. Don't "helpfully"
   * reintroduce it.
   *
   * A diagram with no `shikkhaRender` is still valid and renders as a still
   * picture, which is what keeps videos generated before this contract working.
   */
  canvasHtml?: string;
  /**
   * Phase 5 — cues sharing a sceneId belong to the same visual scene, so
   * the diagram stays mounted across several narration beats instead of
   * being torn down and restarted on every cue (the old behaviour, which
   * is why diagrams flickered and restarted mid-explanation).
   */
  sceneId?: string;
  /**
   * Phase 5 — normalized 0-1 focal point within the diagram for this beat,
   * letting the camera actually move to the part being talked about.
   * Optional; defaults to centre (0.5, 0.5).
   */
  focusX?: number;
  focusY?: number;
}

/** Phase 6 — how the finished lesson should reach the student. Chosen by the model per turn; see the prompt's delivery rule. */
export type VideoDeliveryMode = "INTERACTIVE" | "FILE";

/**
 * LEGACY — the single-track script the Orchestrator used to emit directly.
 *
 * No longer produced. It is still READ, because stored VIDEO turns carry it and
 * dropping it during history hydration is what made old videos vanish once
 * before; `/video/build` routes a body carrying one down the legacy path
 * (PLAN.md §12). New turns emit a `videoBrief` instead, which the director
 * expands into scenes.
 */
export interface VideoScript {
  title: string;
  narration: string;
  accentLocale: string;
  visualCues: VisualCue[];
  /** A short Bangla label for the concept, used as the shared library's reuse key. */
  conceptKey?: string;
  /** Phase 6 — absent is treated as INTERACTIVE. FILE additionally renders a downloadable MP4; it never replaces the player. */
  deliveryMode?: VideoDeliveryMode;
}

export type ResponseType = "TEXT" | "CANVAS" | "VIDEO";

export interface OrchestratorResult {
  responseType: ResponseType;
  reasoning: string;
  content: string;
  /**
   * What a VIDEO turn now emits. Expanded into a full scene script by
   * director.service.ts at /video/build time, not here.
   */
  videoBrief?: VideoBrief;
  /** LEGACY — never set by this module any more; still carried for stored turns being replayed (PLAN.md §12). */
  videoScript?: VideoScript;
  /**
   * Phase 4 — the visual as a first-class field instead of a fenced block
   * recovered out of `content` by regex (PLAN.md B3). ChatMessage.tsx's
   * `extractVisualHtml` stays as the fallback path for already-stored
   * messages and for output that ignores this field.
   */
  visualHtml?: string;
  /**
   * Phase 2 — follow-up questions written in the student's own voice, to be
   * offered as tappable chips. Empty/absent falls back to the static pills
   * in ChatMessage.tsx's buildActionPills.
   */
  suggestions?: string[];
}

/**
 * Phase 6 — a guided-lesson session's state, fed into the same per-turn
 * decision a reactive chat call already makes (see buildOrchestratorSystemPrompt)
 * rather than a parallel "lesson mode" pipeline. `isKickoff` is true only for
 * the very first turn of a brand-new session (lesson.service.ts's
 * startOrResumeLesson) — no real student message exists yet, so the model is
 * told to just start teaching rather than pretend to answer one. On every
 * later turn within an active session, this rides along with the student's
 * actual message: the model answers it, then weaves in the next outline step.
 */
export interface LessonContext {
  isKickoff: boolean;
  stepIndex: number;
  totalSteps: number;
  stepTitle: string;
  stepGoal: string;
}

export interface OrchestratorParams {
  userId: string;
  message: string;
  subject: string;
  chapter: number;
  /** The committed textbook chapter's title, when one exists. */
  chapterTitle?: string;
  /** The topic the student narrowed this conversation to — already validated against their grade and this chapter (chat.service.ts). */
  topic?: { id: string; code: string; title: string };
  history: ChatHistoryTurn[];
  lessonContext?: LessonContext;
}

/**
 * Reads this user's adaptive profile, lazily creating a default-valued row
 * if one doesn't exist yet (e.g. an account created before Phase 8, or a
 * race with the evaluator's first write) — a chat request should never
 * 500 just because the profile row is missing.
 */
async function getOrCreateUserProfile(app: FastifyInstance, userId: string): Promise<UserProfile> {
  const profile = await app.prisma.userProfile.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
  return profile;
}

/**
 * PLAN.md Phase 2 §2.5: "a failed mastery check is a stronger signal than
 * any chat keyword and should influence modality." Looks at this student's
 * most recent *submitted* Mastery Check among nodes in this exact
 * (classLevel, subject, chapter) — not the whole profile's weakTopics
 * (that's cross-topic and already folded in separately via
 * buildProfileHints) — so a fresh failure on the specific thing they're
 * chatting about right now can outweigh a generic profile score.
 */
async function getRecentMasteryFailureHint(
  app: FastifyInstance,
  params: { userId: string; classLevel: number; subject: string; chapter: number },
): Promise<string | null> {
  const attempt = await app.prisma.masteryAttempt.findFirst({
    where: {
      userId: params.userId,
      submittedAt: { not: null },
      node: { classLevel: params.classLevel, subject: params.subject, chapterNumber: params.chapter },
    },
    orderBy: { submittedAt: "desc" },
    select: { passed: true, score: true },
  });

  if (!attempt || attempt.passed !== false) return null;

  return `This student just failed the Mastery Check for this chapter (scored ${attempt.score}%). A purely textual explanation already didn't get this across — strongly prefer CANVAS or VIDEO over TEXT this turn, and be extra patient.`;
}

const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    responseType: { type: "string", enum: ["TEXT", "CANVAS", "VIDEO"] },
    reasoning: { type: "string" },
    content: { type: "string" },
    visualHtml: { type: "string" },
    suggestions: { type: "array", items: { type: "string" } },
    // A BRIEF, not a script. The Orchestrator decides *that* a video is right
    // and says what it should teach; director.service.ts turns that into
    // scenes in a second, focused call inside /video/build — which is already
    // asynchronous, so this costs the student no latency and keeps ~60 lines
    // of video spec out of a prompt that was already carrying too much.
    videoBrief: VIDEO_BRIEF_JSON_SCHEMA,
  },
  required: ["responseType", "reasoning", "content"],
} as const;

/**
 * Phase 4 — the visual is its own field now, so these rules live next to the
 * schema rather than buried in the five-section template they used to sit in.
 * The sandbox constraints are stated explicitly because they are not
 * guessable: the frame is `sandbox="allow-scripts"` with NO
 * `allow-same-origin`, so storage APIs don't merely no-op, they throw and
 * take the whole widget down with them.
 */
const VISUAL_INSTRUCTIONS = `\`visualHtml\` — use this whenever a picture genuinely helps (responseType CANVAS). Put the visual HERE, as its own field. Do NOT paste it into \`content\`, and do not wrap it in a markdown fence.

On a CANVAS turn, \`content\` is STILL THE FULL EXPLANATION — the same real teaching, with the analogy mapped out, that you would have written with no widget at all. The widget supplements your explanation; it never replaces it. Do not write a caption or a lead-in like "চলো ভিজ্যুয়ালটা দেখে বুঝে ফেলি" and leave the teaching to the picture: a student who can't run the widget must still get the whole lesson from your words. Where it fits, build the widget around the SAME analogy your explanation used, so the two reinforce each other instead of teaching two different things.

Build something the student can POKE AT, not a picture they look at. A static drawing is the weakest thing this surface can produce. Pick whichever of these patterns actually fits the concept:
- **slider-sim** — a slider drives one variable and the drawing redraws live (angle, mass, speed, current, temperature). Best for anything with a "what if I change this?" in it.
- **step-through** — a "পরের ধাপ" button walks one stage at a time through a process, with the current stage highlighted. Best for sequences and derivations.
- **tap-to-reveal** — a labelled structure where each part reveals its explanation on tap. Best for anatomy, apparatus, circuit parts, diagram labels.
- **drag-to-match** — drag concepts onto their definitions/examples and check. Best for classification and terminology.
- **compare-toggle** — one button flips between the ANALOGY and the REAL CONCEPT over the same layout, so the mapping is visible. Best whenever your explanation leaned on an analogy.
- **build-it** — the student assembles something (a circuit, a force diagram, a sentence) and presses যাচাই করো to check it.
- **live-graph** — a plot that redraws as inputs change. Best for relationships and proportionality.
- **sort-sequence** — put shuffled steps into the correct order, then check.

Label every control in Bangla ("চালাও", "রিসেট", "পরের ধাপ", "যাচাই করো"). Make the widget teach the thing itself, not decorate it: if a student can get the right answer without understanding, the widget is wrong.

TELLING ME WHAT THE STUDENT DID — this is what makes the widget part of the lesson instead of a toy. The page gives you one global function, \`shikkha\`, already defined. Call it:
- \`shikkha.height(px)\` — whenever your content's height changes, so the frame can size itself to fit.
- \`shikkha.result(correct, detail)\` — the moment the student checks an answer or completes an attempt. \`correct\` is a boolean, \`detail\` is a SHORT Bangla phrase saying what they actually did ("৩০ ডিগ্রিতে সর্বোচ্চ রেঞ্জ বেছেছে"). I will see this and can react to it on the next turn.
- \`shikkha.ask(question)\` — wire this to a small "এটা বুঝিয়ে বলো" button so the student can ask about the exact state they're looking at.
Any widget with a checkable answer MUST call \`shikkha.result\`, but ONLY in response to something the student did — a click on your "যাচাই করো" button, a completed drag. Never call it while drawing the first frame, seeding a slider, or otherwise setting up: that reports an attempt the student never made. Never call these in a loop or on every animation frame.

Hard constraints of the sandbox it runs in — breaking any of these breaks the whole visual:
- Everything inline in one snippet: no external <script>/<link>/font/image URLs, no fetch, no network of any kind.
- NEVER touch localStorage, sessionStorage, or document.cookie. The frame has no same-origin access, so these THROW and kill the widget. Keep state in plain JS variables.
- It must fit and stay readable at roughly 640x400 and scale down on a phone; use viewBox/relative units, not fixed pixel layouts.
- Self-contained means self-contained: one <svg>/<canvas>/<div> root plus its own <style>/<script>, nothing referenced from outside.
- Wrap it in a single <div> root and put your <script> AFTER the closing </svg>, never inside the <svg> — template literals are silently not evaluated in there, which renders raw \`\${...}\` text into your attributes.
- Assume a light background. Use strong, readable colours and font sizes — this is read on a phone.`;

/**
 * Phase 2 — the follow-up chips. These used to be four fixed client-side
 * labels ("Explain with Analogy") rebuilt identically every turn, which read
 * as a toolbar rather than a conversation; buildActionPills in
 * ChatMessage.tsx is now only the fallback for when this comes back empty.
 */
const SUGGESTION_INSTRUCTIONS = `\`suggestions\` — 2-3 follow-up messages, written in the STUDENT'S voice, exactly as they would type them to you in Bangla. First person, short, and specific to what you just explained.

Good: "এটা কি সব ক্ষেত্রেই খাটে?", "তাহলে ঘর্ষণ না থাকলে কী হতো?", "শেষ ধাপটা আরেকবার বলবে?"
Bad (never do this): UI labels or commands like "আরেকটা উদাহরণ দাও", "ভিজ্যুয়াল তৈরি করো", "আমাকে পরীক্ষা করো" — those are buttons, not things a person says.

They must be things this specific student would plausibly wonder *right now*, given what you just said — the honest confusion, the natural "but what about…", the next step. Never generic, never the same set twice in a row.`;

function buildLessonBlock(lessonContext: LessonContext | undefined): string | null {
  if (!lessonContext) return null;
  const { isKickoff, stepIndex, totalSteps, stepTitle, stepGoal } = lessonContext;
  const progress = `step ${stepIndex + 1}/${totalSteps}: "${stepTitle}" — ${stepGoal}`;

  if (isKickoff) {
    return `You are proactively starting a guided lesson for this level — the student hasn't asked anything yet, so don't pretend they did. Just start teaching ${progress}, the way you'd naturally open if you sat down beside them and began.`;
  }

  return `You are also mid-way through a guided lesson for this level. First answer the student's message normally. Then, if their message doesn't need you to stay on a tangent, seamlessly continue the lesson by teaching ${progress}.${
    stepIndex === totalSteps - 1
      ? " This is the last step in the outline — after teaching it, warmly invite them to take the Mastery Check for this level."
      : ""
  }`;
}

function buildOrchestratorSystemPrompt(params: {
  profile: LearningProfile;
  contextChunks: string[];
  weakTopics: string[];
  historyBlock: string | null;
  lessonContext?: LessonContext;
  masteryFailureHint?: string | null;
  studyFocus?: string | null;
}): string {
  const { profile, contextChunks, weakTopics, historyBlock, lessonContext, masteryFailureHint, studyFocus } = params;

  return [
    PERSONA_DESCRIPTION,
    SCOPE_AND_GROUNDING_RULES,
    EXPLANATION_CRAFT_RULES,
    `You must decide how to respond — this is the most important decision you make, so weigh it using everything you know about this specific student:
- TEXT: your explanation in \`content\`, no visual.
- CANVAS: the same, plus an interactive/diagram visual in \`visualHtml\`.
- VIDEO: the concept genuinely needs motion over time that a still picture can't show (a process unfolding, something moving, cause-and-effect in sequence) — not just "this would look nice as a video." Only choose VIDEO if you can actually draw the scenes for it (see below); a narrated slideshow of text is worse than a good CANVAS answer, so if you can't picture the actual diagrams, pick CANVAS.
Never wait for an explicit request like "make a video" or "show me a diagram" — decide autonomously, every turn, from the profile and topic alone.`,
    PERSONALIZATION_RULES,
    VISUAL_INSTRUCTIONS,
    SUGGESTION_INSTRUCTIONS,
    `When responseType is VIDEO: \`content\` is still a genuine short explanation of the concept (2-4 sentences covering the core idea, in your own voice) — not a throwaway caption like "চলো দেখি!". This is what the student sees if the video can't be built, so it must stand on its own.

Then fill \`videoBrief\`. You are NOT writing the video here — a director takes this brief and writes the scenes, the narration and the animation. Give it four things and nothing more:
- \`title\`: what this lesson is called, in Bangla.
- \`conceptKey\`: a short Bangla label for the CONCEPT the video teaches ("ডায়োড কীভাবে এক দিকেই বিদ্যুৎ চলতে দেয়"). This is how the finished lesson is filed and found again for other students, so describe the concept itself, not this student's phrasing of it.
- \`goal\`: what the student should understand by the end. One or two sentences, Bangla. Be specific — "নিউটনের তৃতীয় সূত্র" is a topic, not a goal; "কেন হাঁটার সময় মাটি আমাদের সামনে ঠেলে দেয়" is a goal.
- \`analogy\`: the concrete, everyday Bangladeshi thing the lesson should be built around — a cricket shot, a rickshaw pulling away, a kettle on the stove, load-shedding on the street. Pick one that genuinely maps onto the mechanism, not one that merely sounds familiar.

The video will be DRAWN — labelled diagrams, arrows, force vectors, graphs, equations, numbers that change as things move. It is not filmed footage. So a concept is a good candidate when seeing it MOVE is what makes it click; if a still picture would do, CANVAS is the better answer.

There is no length limit to worry about and no budget to protect: pick the concept that deserves a proper lesson and let the director give it the time it needs.`,
    `Always fill \`reasoning\` with one short sentence on why you picked this responseType — internal logging, never shown to the student.`,
    buildProfileHints(profile, weakTopics),
    masteryFailureHint,
    historyBlock ? `Recent conversation:\n${historyBlock}` : null,
    studyFocus,
    `NCTB textbook context:\n${buildContextBlock(contextChunks)}`,
    buildLessonBlock(lessonContext),
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n\n");
}

function isOptionalString(x: unknown): boolean {
  return x === undefined || typeof x === "string";
}

function isOptionalNumber(x: unknown): boolean {
  return x === undefined || typeof x === "number";
}

function isVisualCue(x: unknown): x is VisualCue {
  if (!x || typeof x !== "object") return false;
  const v = x as Record<string, unknown>;
  if (typeof v.timeMs !== "number" || typeof v.animationType !== "string" || typeof v.highlightText !== "string") {
    return false;
  }
  return (
    isOptionalString(v.canvasHtml) &&
    isOptionalString(v.sceneId) &&
    isOptionalNumber(v.focusX) &&
    isOptionalNumber(v.focusY)
  );
}

function isVideoScript(x: unknown): x is VideoScript {
  if (!x || typeof x !== "object") return false;
  const v = x as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.narration === "string" &&
    typeof v.accentLocale === "string" &&
    (v.deliveryMode === undefined || v.deliveryMode === "INTERACTIVE" || v.deliveryMode === "FILE") &&
    (v.conceptKey === undefined || typeof v.conceptKey === "string") &&
    Array.isArray(v.visualCues) &&
    v.visualCues.every(isVisualCue)
  );
}

const MAX_SUGGESTIONS = 3;
const MAX_SUGGESTION_LENGTH = 120;

/**
 * Phase 2 — keeps only suggestions that are actually usable as a chip *and*
 * as a message: non-empty strings, deduped, length-capped (an over-long
 * "suggestion" is the model writing a sentence of its own rather than
 * something a student would tap). Returns undefined rather than an empty
 * array so callers can cleanly fall back to the static pills.
 */
export function parseSuggestions(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const cleaned: string[] = [];

  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || trimmed.length > MAX_SUGGESTION_LENGTH || seen.has(trimmed)) continue;
    seen.add(trimmed);
    cleaned.push(trimmed);
    if (cleaned.length === MAX_SUGGESTIONS) break;
  }

  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Normalizes `sceneId` onto EVERY cue, carrying it forward across
 * continuation beats.
 *
 * This exists because of what the model actually emits, not what it's asked
 * for: it tags the cue that *introduces* a scene and leaves `sceneId` empty on
 * the beats that continue it. A real generated script looked like
 *
 *   cue0 scene=cricket_field diagram=1723ch
 *   cue1 scene=-             diagram=NONE     <- continues cricket_field
 *   cue2 scene=atmosphere    diagram=1169ch
 *   cue3 scene=-             diagram=NONE     <- continues atmosphere
 *
 * so anything keyed on `sceneId` equality alone treats five of nine cues as
 * scene-less, throws the picture away, and renders them as text cards. That
 * was the "it's just a text slideshow" complaint.
 *
 * The rule, stated once here and relied on by both the coverage gate below
 * and LessonComposition's grouping: a cue opens a new scene if it carries a
 * `canvasHtml`, or names a `sceneId` different from the one in force.
 * Otherwise it continues the current scene and inherits its id.
 *
 * `canvasHtml` is deliberately NOT copied onto continuation cues — the client
 * finds a scene's diagram by grouping, so duplicating a ~1.5KB SVG onto every
 * beat would just bloat the payload and every stored history row.
 */
export function resolveSceneIds(cues: VisualCue[]): VisualCue[] {
  const used = new Set<string>();
  // Empty string means "no scene in force yet" — a plain string keeps the
  // return type `VisualCue` (whose sceneId is `string | undefined`) rather
  // than leaking a null through the map below.
  let current = "";
  let autoIndex = 0;

  /**
   * Two different pictures must never share an id, or grouping silently
   * merges them. The model does reuse ids — it treats `sceneId` as a topic
   * label ("s", "forces") rather than a unique key — so a repeat is
   * disambiguated rather than trusted.
   */
  const uniquify = (base: string): string => {
    if (!used.has(base)) return base;
    let candidate = `${base}-${autoIndex++}`;
    while (used.has(candidate)) candidate = `${base}-${autoIndex++}`;
    return candidate;
  };

  return cues.map((cue) => {
    const startsNewScene =
      // Leading beats before any diagram or named scene still need an id to group under.
      !current || Boolean(cue.canvasHtml) || (Boolean(cue.sceneId) && cue.sceneId !== current);

    if (startsNewScene) {
      current = uniquify(cue.sceneId || `scene-${autoIndex++}`);
      used.add(current);
    }

    return { ...cue, sceneId: current };
  });
}

/**
 * A visual bigger than this is a runaway generation, not a teaching aid — we
 * refuse to persist or ship it rather than let one turn bloat the row, the
 * SSE frame, and every later history load.
 */
const MAX_VISUAL_HTML_LENGTH = 24_000;

/** A usable widget has to actually contain drawable markup — these are the roots the sandbox can render. */
const VISUAL_ROOT_TAG_PATTERN = /<(svg|canvas|div|section|figure)[\s>]/i;

/**
 * Same recovery the frontend's `extractVisualHtml` does, kept server-side so a
 * visual pasted into `content` (against instructions) is salvaged into the
 * field it belongs in, instead of being rendered as escaped literal markup in
 * the chat bubble.
 */
const FENCED_HTML_PATTERN = /```(?:html|svg)?\s*\n([\s\S]*?)```/i;
const BARE_VISUAL_TAG_PATTERN = /<(svg|canvas)[\s>][\s\S]*?<\/\1>/i;

/**
 * Validates the model's `visualHtml`. Returns undefined for anything that
 * isn't a real, shippable widget so callers can apply the CANVAS degradation
 * rule rather than promising a visual that renders as a blank frame.
 */
export function parseVisualHtml(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_VISUAL_HTML_LENGTH) return undefined;
  if (!VISUAL_ROOT_TAG_PATTERN.test(trimmed)) return undefined;
  return trimmed;
}

/** Last-resort salvage: pull a visual out of `content` when the model ignored the field and inlined it anyway. */
export function salvageVisualFromContent(content: string): { prose: string; visualHtml?: string } {
  const fenced = content.match(FENCED_HTML_PATTERN);
  if (fenced) {
    const candidate = parseVisualHtml(fenced[1]);
    if (candidate) return { prose: content.replace(FENCED_HTML_PATTERN, "").trim(), visualHtml: candidate };
  }
  const bare = content.match(BARE_VISUAL_TAG_PATTERN);
  if (bare) {
    const candidate = parseVisualHtml(bare[0]);
    if (candidate) return { prose: content.replace(BARE_VISUAL_TAG_PATTERN, "").trim(), visualHtml: candidate };
  }
  return { prose: content };
}

/**
 * Models routinely wrap structured output in a markdown fence even when asked
 * for raw JSON. Before this existed, `JSON.parse` threw on the backticks and
 * the catch-all handed the *raw string* back as `content` — so a fenced reply
 * rendered as visible raw JSON in the chat bubble. Strip the fence, and
 * failing that take the outermost brace span, before giving up.
 */
export function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();

  // A payload that already parses is returned untouched. This ordering is
  // load-bearing, not an optimization: a perfectly valid response's own
  // `content` can contain a ```html block (the model inlining a visual), and
  // the unwrapping below would happily tear that fence out of the middle of
  // the JSON and hand back a fragment that parses as nothing.
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Not valid JSON as-is — fall through to the recovery attempts below.
  }

  // Anchored to the ends deliberately, for the same reason: only a fence
  // wrapping the WHOLE reply is a wrapper worth stripping.
  const fenced = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)```\s*$/i);
  if (fenced?.[1]) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);

  return trimmed;
}

/**
 * Shown when output is unsalvageable. Deliberately a real Bangla sentence in
 * persona: the previous behaviour put the unparsed model output straight into
 * the bubble, which meant a bad turn showed the student raw JSON.
 */
const UNPARSEABLE_FALLBACK_CONTENT =
  "ইশ, কথাটা গুছিয়ে বলতে গিয়ে একটু গড়বড় করে ফেললাম। আরেকবার জিজ্ঞেস করো তো, এবার ঠিকঠাক বুঝিয়ে বলছি।";

/** Parses and validates the model's JSON output; degrades to a usable TEXT result rather than throwing on anything malformed. */
export function parseOrchestratorResult(raw: string): OrchestratorResult {
  try {
    const parsed = JSON.parse(extractJsonPayload(raw)) as Record<string, unknown>;
    const responseType = parsed.responseType;
    if (responseType !== "TEXT" && responseType !== "CANVAS" && responseType !== "VIDEO") {
      throw new Error(`invalid responseType: ${String(responseType)}`);
    }
    if (typeof parsed.content !== "string") {
      throw new Error("missing content field");
    }
    const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
    // Every optional field declared in RESPONSE_JSON_SCHEMA must be read here
    // and carried onto the result. Both of these were declared, prompted for,
    // and then silently dropped by this function — which is why no CANVAS turn
    // ever produced a visual and the follow-up chips were always the static
    // fallback set. See CLAUDE.md's parser invariant.
    const suggestions = parseSuggestions(parsed.suggestions);

    if (responseType === "VIDEO") {
      const videoBrief = parseVideoBrief(parsed.videoBrief);
      if (!videoBrief) {
        // Claimed VIDEO but gave nothing usable to build one from. Degrade
        // rather than fail the turn — and degrade rather than ship a "watch
        // this" button that leads nowhere, which is the same rule that governs
        // a CANVAS turn with no widget (CLAUDE.md guardrail #9).
        return {
          responseType: "TEXT",
          reasoning: "fallback: VIDEO requested without a usable videoBrief",
          content: parsed.content,
          suggestions,
        };
      }

      // Note what is NOT validated here any more: scene count, diagram
      // coverage, animation share. Those gates existed because the Orchestrator
      // wrote the scenes itself and could write a narrated slideshow. It no
      // longer writes them — the director does, and the renderer either
      // produces a real animation or the scene falls back (PLAN.md §8). The
      // quality gate moved to where the quality is now decided.
      return { responseType, reasoning, content: parsed.content, videoBrief, suggestions };
    }

    const declaredVisual = parseVisualHtml(parsed.visualHtml);
    if (responseType === "CANVAS") {
      // The CANVAS analogue of the VIDEO degradation rules above: a CANVAS
      // turn promises a widget, and the UI opens a panel for it. If the field
      // is missing or unusable, try to rescue one the model inlined into
      // `content` anyway, and otherwise call it what it is — a TEXT answer —
      // instead of opening an empty panel.
      const salvaged = declaredVisual ? null : salvageVisualFromContent(parsed.content);
      const visualHtml = declaredVisual ?? salvaged?.visualHtml;
      if (!visualHtml) {
        return {
          responseType: "TEXT",
          reasoning: "fallback: CANVAS claimed without usable visualHtml — downgraded to TEXT",
          content: parsed.content,
          suggestions,
        };
      }
      return {
        responseType,
        reasoning,
        content: salvaged ? salvaged.prose : parsed.content,
        visualHtml,
        suggestions,
      };
    }

    // TEXT. A visual is not required, but if one came along anyway it's a
    // free win for the student — keep it rather than discard it.
    return { responseType, reasoning, content: parsed.content, visualHtml: declaredVisual, suggestions };
  } catch (err) {
    return {
      responseType: "TEXT",
      reasoning: `fallback: ${(err as Error).message}`,
      content: UNPARSEABLE_FALLBACK_CONTENT,
    };
  }
}

/** Used only if the structured (json_schema) call itself errors — e.g. the endpoint rejects response_format. Keeps chat working, just without guaranteed structure. */
async function fallbackPlainCompletion(systemPrompt: string, message: string): Promise<OrchestratorResult> {
  const completion = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      {
        role: "system",
        content: `${systemPrompt}\n\nThis time, skip the JSON wrapper entirely — just write your explanation directly, as ordinary Bangla prose following the rules above. If a diagram genuinely helps, put it in a single \`\`\`html fenced block at the end.`,
      },
      { role: "user", content: message },
    ],
  });

  // No JSON wrapper here, so `visualHtml` can't be a field — the fenced block
  // asked for above is recovered into it instead, which is why this path still
  // produces a working widget rather than a bubble full of escaped markup.
  const rawContent = completion.choices[0]?.message?.content ?? "";
  const { prose, visualHtml } = salvageVisualFromContent(rawContent);

  return {
    responseType: visualHtml ? "CANVAS" : "TEXT",
    reasoning: "fallback: structured output call failed, used a plain completion instead",
    content: prose,
    visualHtml,
  };
}

/**
 * The Central Brain: one call that reads the student's message, adaptive
 * profile, cached weak topics, and recent history, and decides both *what*
 * to say and *how* to say it (plain text, an inline canvas, or a narrated
 * video) — autonomously, every turn, per PROMPT.md's Core Rules.
 */
export async function orchestrate(app: FastifyInstance, params: OrchestratorParams): Promise<OrchestratorResult> {
  const user = await app.prisma.user.findUniqueOrThrow({ where: { id: params.userId } });
  const profile = await getOrCreateUserProfile(app, params.userId);

  // On a lesson kickoff there's no real student message to embed — it's a
  // placeholder (see lesson.service.ts) that would retrieve irrelevant
  // chunks. Embed the step's own title/goal instead; on a reactive turn
  // (lessonContext absent, or present-but-not-kickoff) the student's actual
  // message is still what should drive retrieval.
  const retrievalQuery = params.lessonContext?.isKickoff
    ? `${params.lessonContext.stepTitle}. ${params.lessonContext.stepGoal}`
    : params.message;
  const queryEmbedding = await embedText(retrievalQuery);
  const searchResults = await searchDocumentChunks(app, {
    classLevel: user.classLevel,
    subject: params.subject,
    chapter: params.chapter,
    queryEmbedding,
    topicId: params.topic?.id,
  });

  const masteryFailureHint = await getRecentMasteryFailureHint(app, {
    userId: params.userId,
    classLevel: user.classLevel,
    subject: params.subject,
    chapter: params.chapter,
  });

  const systemPrompt = buildOrchestratorSystemPrompt({
    profile,
    contextChunks: searchResults.map((m) => m.content),
    weakTopics: profile.weakTopics ?? [],
    historyBlock: buildHistoryBlock(params.history),
    lessonContext: params.lessonContext,
    masteryFailureHint,
    studyFocus: buildStudyFocusLine(params.chapter, params.chapterTitle, params.topic),
  });

  try {
    const completion = await chatClient.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: params.message },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "orchestrator_response", schema: RESPONSE_JSON_SCHEMA },
      },
    });

    return parseOrchestratorResult(completion.choices[0]?.message?.content ?? "");
  } catch (err) {
    app.log.error(err, "Orchestrator structured call failed — falling back to a plain completion");
    return fallbackPlainCompletion(systemPrompt, params.message);
  }
}
