import type { VideoScript } from "../chat/orchestrator";
import type { VideoBrief } from "./director.schema";
import type { WordTiming } from "../speech/edge-speech.service";
import type { LessonSceneView } from "./lesson-build.service";

/**
 * `/video/build` takes EITHER shape, and which one it gets decides which
 * pipeline runs (PLAN.md §12):
 *
 *  - `videoBrief`  → the Manim pipeline: direct, narrate per scene, render.
 *  - `videoScript` → LEGACY replay of a turn stored before that existed.
 *
 * Both are optional in the JSON schema and the route rejects a body carrying
 * neither. Keeping the legacy door open is not politeness: CLAUDE.md records
 * that dropping stored `videoScript` during hydration is what made old videos
 * vanish once already.
 */
export interface VideoBuildRequestBody {
  videoBrief?: VideoBrief;
  /** LEGACY — a stored turn being replayed. */
  videoScript?: VideoScript;
  /** Needed for grade isolation and the shared library. */
  subject?: string;
  chapter?: number;
  /** When the lesson is tied to a roadmap level, the strongest reuse key. */
  nodeId?: string;
  /** Set when the student asked for a different take, so a seen variant isn't replayed. */
  wantsNewVariant?: boolean;
}

export interface VideoLessonResponse {
  title: string;
  /** Empty for a lesson replayed from the library, which plays as `lessonUrl`. */
  scenes: LessonSceneView[];
  /** The assembled MP4 — download, and what `deliveryMode: "FILE"` means. */
  lessonUrl?: string;
  totalDurationMs: number;
  /** Lesson-relative word timings for captions and timestamp-ask. */
  timestampManifest: WordTiming[];
  /** True while the build runs in the background; the client should poll again. */
  generating: boolean;
  /** True when this came from the shared library and cost nothing. */
  reused: boolean;
  /** Set when the build failed for good — stop polling and say so. */
  failed?: string;

  /* ── Legacy replay fields ──────────────────────────────────────────────
   * Present only on the legacy path, where the player still drives one
   * narration track against `visualCues`. Absent on every new lesson. */
  videoScript?: VideoScript;
  audioUrl?: string;
}

export interface ErrorResponse {
  error: string;
}

export const videoBuildBodySchema = {
  type: "object",
  properties: {
    subject: { type: "string" },
    chapter: { type: "integer", minimum: 1 },
    nodeId: { type: "string" },
    wantsNewVariant: { type: "boolean" },
    videoBrief: {
      type: "object",
      required: ["title", "goal"],
      properties: {
        title: { type: "string", minLength: 1 },
        conceptKey: { type: "string" },
        goal: { type: "string", minLength: 1 },
        analogy: { type: "string" },
      },
    },
    // Legacy. Declared in full rather than left to `additionalProperties`,
    // for the reason the previous version of this file recorded: the optional
    // fields survive today only because Fastify's AJV `removeAdditional: true`
    // needs `additionalProperties: false` to actually strip, and it isn't set.
    // Declaring them keeps that contract intentional.
    videoScript: {
      type: "object",
      required: ["title", "narration", "accentLocale", "visualCues"],
      properties: {
        title: { type: "string" },
        narration: { type: "string", minLength: 1 },
        accentLocale: { type: "string" },
        deliveryMode: { type: "string" },
        conceptKey: { type: "string" },
        visualCues: {
          type: "array",
          items: {
            type: "object",
            required: ["timeMs", "animationType", "highlightText"],
            properties: {
              timeMs: { type: "number" },
              animationType: { type: "string" },
              highlightText: { type: "string" },
              canvasHtml: { type: "string" },
              sceneId: { type: "string" },
              focusX: { type: "number" },
              focusY: { type: "number" },
            },
          },
        },
      },
    },
  },
} as const;
