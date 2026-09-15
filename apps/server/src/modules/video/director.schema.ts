import { env } from "../../config/env";

/**
 * The directed script — PLAN.md §4.
 *
 * This is the contract between the Orchestrator's decision ("this student needs
 * a video") and everything that builds one. It replaces the old single-track
 * `VideoScript`, whose `narration` was one blob of text and whose `visualCues`
 * carried a `timeMs` the model had guessed before any audio existed.
 *
 * The structural difference, and the whole reason the sync defect cannot come
 * back: narration is CHUNKED PER SCENE. Each chunk is narrated on its own, so
 * a scene's duration is a measured fact about its own audio rather than an
 * estimate reconciled after the fact.
 */

/**
 * What the Orchestrator emits on a VIDEO turn — a brief, not a script.
 *
 * Deliberately small. The Orchestrator's single call already carries the
 * persona, the craft rules, the personalization thresholds, the widget spec and
 * the suggestion spec; asking it to also direct a multi-scene video made the
 * chat answer itself worse. The director (director.service.ts) expands this
 * into scenes in a second, focused call that runs inside /video/build, where
 * there is already a polling contract — so this costs the student no latency.
 */
export interface VideoBrief {
  /** Lesson title, Bangla. */
  title: string;
  /** Short Bangla label for the CONCEPT — the shared library's reuse key. */
  conceptKey: string;
  /** What the student should understand by the end. One or two sentences, Bangla. */
  goal: string;
  /** The concrete, everyday analogy to build the lesson around. Bangla. */
  analogy?: string;
}

/**
 * A scene's narrative function. Drives pacing and is handed to the code
 * generator, so a HOOK is drawn differently from a WORKED_EXAMPLE.
 */
export type SceneRole = "HOOK" | "ANALOGY" | "MECHANISM" | "WORKED_EXAMPLE" | "MISCONCEPTION" | "RECAP";

export const SCENE_ROLES: readonly SceneRole[] = [
  "HOOK",
  "ANALOGY",
  "MECHANISM",
  "WORKED_EXAMPLE",
  "MISCONCEPTION",
  "RECAP",
] as const;

/** One beat inside a scene — a caption and a place to point the camera. */
export interface SceneBeat {
  /**
   * Position within THIS scene, 0-1. Not a millisecond: the scene's real
   * length isn't known until its narration has been synthesized, and a beat
   * expressed in absolute time would be the old guess-then-reconcile mistake
   * in a new field name.
   */
  at: number;
  /** Short Bangla phrase spoken at this moment; shown as the lower-third label. */
  highlightText: string;
  /** Normalized focal point within the picture, for the camera push-in. */
  focusX?: number;
  focusY?: number;
}

export interface DirectedScene {
  id: string;
  role: SceneRole;
  /**
   * THE CHUNK. Bangla, spoken, this scene only — narrated on its own, and its
   * measured audio length becomes the scene's duration.
   */
  narration: string;
  /** Full prose direction for the renderer: what is on screen, what moves, what it means. */
  visualBrief: string;
  /** Bangla labels that must appear. Kept apart from mathTex — see PLAN.md §5.1. */
  labels: string[];
  /** LaTeX fragments (equations, numerals, symbols). NEVER Bangla. */
  mathTex: string[];
  /** What the previous scene leaves on screen, so scenes transform rather than cut. */
  carryOver?: string;
  beats: SceneBeat[];
}

export interface DirectedScript {
  title: string;
  conceptKey: string;
  /**
   * One paragraph on the teaching arc — how scene N earns scene N+1.
   *
   * Not decoration: this is fed to every per-scene code-generation call, so
   * scene 3 knows what scene 2 established and can keep the same layout,
   * colours and positions. It is what makes the output a directed lesson
   * rather than a list of unrelated pictures.
   */
  approach: string;
  scenes: DirectedScene[];
}

/* ── Limits ─────────────────────────────────────────────────────────────────
 * The old ceiling was 30 seconds, and it existed only because footage cost
 * $0.03/s. Rendering is free, so a lesson can now run long enough to actually
 * finish a concept (PLAN.md §4.1). These are sanity bounds, not budget ones.
 */

const MIN_SCENES = 2;
const MIN_NARRATION_CHARS = 20;
const MAX_NARRATION_CHARS = 1200;
const MAX_VISUAL_BRIEF_CHARS = 2000;
const MAX_BEATS_PER_SCENE = 6;
const MAX_LABELS = 8;
const MAX_MATHTEX = 8;

/**
 * Bangla reads at roughly 12 characters per second of speech. Used only to
 * reject a script that would obviously blow the runtime ceiling BEFORE paying
 * to narrate it — the real durations come from the audio itself.
 */
export const BANGLA_CHARS_PER_SECOND = 12;

export function estimateSecondsFromText(text: string): number {
  return text.trim().length / BANGLA_CHARS_PER_SECOND;
}

/* ── Validation ─────────────────────────────────────────────────────────────
 * Same defensive posture as parseOrchestratorResult: never throw, return
 * undefined for anything unusable, and let the caller degrade. A director that
 * throws would turn a bad model response into a failed lesson; a director that
 * returns undefined turns it into a TEXT answer, which is a real answer.
 */

function cleanStringArray(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) out.push(trimmed);
    if (out.length === max) break;
  }
  return out;
}

function parseBeats(raw: unknown): SceneBeat[] {
  if (!Array.isArray(raw)) return [];
  const beats: SceneBeat[] = [];

  for (const item of raw.slice(0, MAX_BEATS_PER_SCENE)) {
    if (!item || typeof item !== "object") continue;
    const beat = item as Record<string, unknown>;
    if (typeof beat.highlightText !== "string" || !beat.highlightText.trim()) continue;

    const at = typeof beat.at === "number" && Number.isFinite(beat.at) ? Math.min(1, Math.max(0, beat.at)) : 0;
    beats.push({
      at,
      highlightText: beat.highlightText.trim(),
      ...(typeof beat.focusX === "number" ? { focusX: Math.min(1, Math.max(0, beat.focusX)) } : {}),
      ...(typeof beat.focusY === "number" ? { focusY: Math.min(1, Math.max(0, beat.focusY)) } : {}),
    });
  }

  // Ascending, so the player can walk them without sorting and a bad ordering
  // can't make a later beat appear to fire before an earlier one.
  return beats.sort((a, b) => a.at - b.at);
}

/** Bengali block. LaTeX cannot typeset any of it. */
const BANGLA_PATTERN = /[\u0980-\u09FF]/;

/**
 * Splits the director's `mathTex` into what LaTeX can actually set, and what
 * has to become an on-screen label instead.
 *
 * This is the fix for the most stubborn code-generation failure observed in
 * real output, and it works because it removes the CAUSE rather than arguing
 * with the symptom. The director is told never to put Bangla in `mathTex`, and
 * it does anyway; the scene prompt then dutifully passes it along as "LATEX
 * that must appear", so the generator is being explicitly *instructed* to write
 * `MathTex("বেগ")`. The validator then rejects it, the retry regenerates from
 * the same instruction, and it fails again the same way.
 *
 * Moving those entries into `labels` means the generator is asked for exactly
 * what it can deliver, and the content survives instead of being dropped.
 */
export function splitMathAndLabels(
  mathTex: string[],
  labels: string[],
): { mathTex: string[]; labels: string[] } {
  const latex: string[] = [];
  const moved: string[] = [];

  for (const entry of mathTex) {
    (BANGLA_PATTERN.test(entry) ? moved : latex).push(entry);
  }

  // Deduped: a term the director listed in both fields should appear once.
  const merged = [...labels];
  for (const label of moved) if (!merged.includes(label)) merged.push(label);

  return { mathTex: latex, labels: merged };
}

function parseScene(raw: unknown, index: number): DirectedScene | null {
  if (!raw || typeof raw !== "object") return null;
  const scene = raw as Record<string, unknown>;

  const narration = typeof scene.narration === "string" ? scene.narration.trim() : "";
  if (narration.length < MIN_NARRATION_CHARS || narration.length > MAX_NARRATION_CHARS) return null;

  const visualBrief = typeof scene.visualBrief === "string" ? scene.visualBrief.trim() : "";
  if (!visualBrief) return null;

  const role = SCENE_ROLES.includes(scene.role as SceneRole) ? (scene.role as SceneRole) : "MECHANISM";
  const id = typeof scene.id === "string" && scene.id.trim() ? scene.id.trim() : `scene-${index}`;

  const split = splitMathAndLabels(
    cleanStringArray(scene.mathTex, MAX_MATHTEX),
    cleanStringArray(scene.labels, MAX_LABELS),
  );

  return {
    id,
    role,
    narration,
    visualBrief: visualBrief.slice(0, MAX_VISUAL_BRIEF_CHARS),
    labels: split.labels.slice(0, MAX_LABELS),
    mathTex: split.mathTex,
    ...(typeof scene.carryOver === "string" && scene.carryOver.trim()
      ? { carryOver: scene.carryOver.trim() }
      : {}),
    beats: parseBeats(scene.beats),
  };
}

export interface DirectedScriptRejection {
  reason: string;
}

/**
 * Validates and normalizes the director's output.
 *
 * Scene ids are uniquified rather than trusted: the model reuses labels like
 * "s1" or "forces" across scenes, and anything keyed on id equality downstream
 * would silently merge two different pictures — the same failure `resolveSceneIds`
 * was written to fix on the legacy path.
 */
export function parseDirectedScript(raw: unknown): DirectedScript | DirectedScriptRejection {
  if (!raw || typeof raw !== "object") return { reason: "director returned no object" };
  const script = raw as Record<string, unknown>;

  const title = typeof script.title === "string" ? script.title.trim() : "";
  const conceptKey = typeof script.conceptKey === "string" ? script.conceptKey.trim() : "";
  if (!title) return { reason: "missing title" };

  if (!Array.isArray(script.scenes)) return { reason: "missing scenes array" };

  const seenIds = new Set<string>();
  const scenes: DirectedScene[] = [];
  let estimatedSeconds = 0;

  for (const [index, rawScene] of script.scenes.slice(0, env.VIDEO_MAX_SCENES).entries()) {
    const scene = parseScene(rawScene, index);
    if (!scene) continue;

    let id = scene.id;
    let suffix = 2;
    while (seenIds.has(id)) id = `${scene.id}-${suffix++}`;
    seenIds.add(id);

    const seconds = estimateSecondsFromText(scene.narration);
    // Stop at the ceiling rather than truncating a scene's narration to fit:
    // a scene cut mid-sentence is worse than one fewer scene.
    if (estimatedSeconds + seconds > env.VIDEO_MAX_TOTAL_SEC) break;
    estimatedSeconds += seconds;

    scenes.push({ ...scene, id });
  }

  if (scenes.length < MIN_SCENES) {
    return { reason: `only ${scenes.length} usable scenes (need at least ${MIN_SCENES})` };
  }

  return {
    title,
    conceptKey: conceptKey || title,
    approach: typeof script.approach === "string" ? script.approach.trim() : "",
    scenes,
  };
}

export function isDirectedScript(value: DirectedScript | DirectedScriptRejection): value is DirectedScript {
  return "scenes" in value;
}

/* ── The model-facing JSON schema ───────────────────────────────────────────*/

export const DIRECTED_SCRIPT_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    conceptKey: { type: "string" },
    approach: { type: "string" },
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          role: { type: "string", enum: [...SCENE_ROLES] },
          narration: { type: "string" },
          visualBrief: { type: "string" },
          labels: { type: "array", items: { type: "string" } },
          mathTex: { type: "array", items: { type: "string" } },
          carryOver: { type: "string" },
          beats: {
            type: "array",
            items: {
              type: "object",
              properties: {
                at: { type: "number" },
                highlightText: { type: "string" },
                focusX: { type: "number" },
                focusY: { type: "number" },
              },
              required: ["at", "highlightText"],
            },
          },
        },
        required: ["id", "role", "narration", "visualBrief", "beats"],
      },
    },
  },
  required: ["title", "conceptKey", "approach", "scenes"],
} as const;

/* ── The brief, as the Orchestrator emits it ────────────────────────────────*/

export function parseVideoBrief(raw: unknown): VideoBrief | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const brief = raw as Record<string, unknown>;

  const title = typeof brief.title === "string" ? brief.title.trim() : "";
  const goal = typeof brief.goal === "string" ? brief.goal.trim() : "";
  if (!title || !goal) return undefined;

  const conceptKey = typeof brief.conceptKey === "string" ? brief.conceptKey.trim() : "";

  return {
    title,
    goal,
    conceptKey: conceptKey || title,
    ...(typeof brief.analogy === "string" && brief.analogy.trim() ? { analogy: brief.analogy.trim() } : {}),
  };
}

export const VIDEO_BRIEF_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    conceptKey: { type: "string" },
    goal: { type: "string" },
    analogy: { type: "string" },
  },
  required: ["title", "conceptKey", "goal"],
} as const;
