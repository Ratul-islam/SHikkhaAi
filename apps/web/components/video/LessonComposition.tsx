import { useEffect, useMemo, useRef } from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { buildSandboxBody } from "../../lib/sandboxHtml";
import type { LessonBeat, LessonSceneView, VisualCue, WordTiming } from "../../lib/types";

/**
 * The lesson player.
 *
 * A lesson is a list of SCENES laid end to end, and each scene owns its own
 * narration. That is the whole architecture, and it is what fixed the sync
 * defect: a scene's `durationMs` is measured from its own audio and its
 * `startMs` is the sum of the scenes before it, so the picture and the words
 * cannot come apart.
 *
 * What this replaced: ONE narration track starting at frame 0, a cue timeline
 * re-anchored to that track by word matching, and then the whole cue timeline
 * shifted by the total footage length — which put every diagram exactly one
 * reel-length out of step with the sentence it illustrated. The captions read
 * the unshifted clock and stayed right, which is why the visible symptom was
 * captions racing ahead of the pictures.
 *
 * There is no offset arithmetic anywhere in this file any more. Remotion's
 * <Sequence> places each scene, and its <Audio> child rides along with it.
 */

const CAPTION_WINDOW = 10;

/* ── Camera ────────────────────────────────────────────────────────────────
 * `focusX`/`focusY` say which part of the picture a beat is about. They drive
 * a gentle push-in toward that point, which is what turns a static frame into
 * "look at THIS bit now."
 */

const CAMERA_SCALE = 1.28;
const CAMERA_EASE_MS = 700;

function cameraTransform(beat: LessonBeat | null, beatAgeMs: number, reducedMotion?: boolean): string {
  if (reducedMotion || !beat) return "scale(1) translate(0px, 0px)";

  const hasFocus = typeof beat.focusX === "number" || typeof beat.focusY === "number";
  if (!hasFocus) return "scale(1) translate(0px, 0px)";

  const fx = Math.min(1, Math.max(0, beat.focusX ?? 0.5));
  const fy = Math.min(1, Math.max(0, beat.focusY ?? 0.5));

  const progress = interpolate(beatAgeMs, [0, CAMERA_EASE_MS], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const scale = 1 + (CAMERA_SCALE - 1) * progress;

  // The 50/scale factor keeps the translation in the scaled element's own
  // coordinate space; the clamp stops the frame panning past its own edges.
  const maxShiftPct = (50 * (scale - 1)) / scale;
  const shiftX = -((fx - 0.5) * 2 * maxShiftPct) * progress;
  const shiftY = -((fy - 0.5) * 2 * maxShiftPct) * progress;

  return `scale(${scale}) translate(${shiftX}%, ${shiftY}%)`;
}

/** Keeps a long beat label from swallowing the picture it captions. */
function labelFontSize(text: string): number {
  if (text.length > 90) return 20;
  if (text.length > 55) return 24;
  return 30;
}

/** The beat in force at this moment within a scene, and how long it has been up. */
function activeBeat(beats: LessonBeat[], sceneStartMs: number, absoluteMs: number): { beat: LessonBeat | null; ageMs: number } {
  let found: LessonBeat | null = null;
  for (const beat of beats) {
    if (beat.timeMs > absoluteMs) break;
    found = beat;
  }
  return { beat: found, ageMs: found ? absoluteMs - found.timeMs : absoluteMs - sceneStartMs };
}

/* ── The fallback stage ────────────────────────────────────────────────────
 * Shown for a scene whose Manim render failed (PLAN.md §8). It is deliberately
 * NOT a generic "something went wrong" panel: the audio for this scene is
 * correct, in sync, and still teaching, so the picture's job is to stay out of
 * the way and caption it legibly in the same visual language as a rendered
 * scene. A student should experience a plainer moment, not a broken one.
 */
function FallbackStage({ beat, ageMs }: { beat: LessonBeat | null; ageMs: number }) {
  const opacity = interpolate(ageMs, [0, 300], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const rise = interpolate(ageMs, [0, 400], [14, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", padding: "0 96px" }}>
      <div
        style={{
          opacity,
          transform: `translateY(${rise}px)`,
          fontSize: 40,
          fontWeight: 700,
          lineHeight: 1.45,
          textAlign: "center",
          textShadow: "0 2px 18px rgba(0,0,0,0.5)",
        }}
      >
        {beat?.highlightText ?? ""}
      </div>
    </AbsoluteFill>
  );
}

/* ── One scene ─────────────────────────────────────────────────────────────*/

function SceneStage({
  scene,
  reducedMotion,
}: {
  scene: LessonSceneView;
  reducedMotion?: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  // Inside a <Sequence>, `frame` is scene-local and starts at 0. Beats are
  // stored lesson-absolute, so shift into the same space rather than rewriting
  // every beat: one addition here, versus a second representation to keep in
  // step everywhere else.
  const absoluteMs = scene.startMs + (frame / fps) * 1000;

  const { beat, ageMs } = activeBeat(scene.beats, scene.startMs, absoluteMs);
  const transform = cameraTransform(beat, ageMs, reducedMotion);

  // Cross-fade in, so a new scene reads as a new idea rather than a hard cut.
  // reducedMotion keeps the fade (an opacity ramp, not movement) and drops the
  // camera entirely.
  const sceneAgeMs = (frame / fps) * 1000;
  const opacity = interpolate(sceneAgeMs, [0, 400], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ opacity }}>
      {/* The scene's own narration. Placed inside the Sequence, so Remotion
          starts it exactly when the scene starts — no offset to compute and
          none to get wrong. */}
      <Audio src={scene.audioUrl} />

      {scene.videoUrl ? (
        <AbsoluteFill
          style={{
            transform: reducedMotion ? undefined : transform,
            transformOrigin: "center center",
          }}
        >
          <OffthreadVideo
            src={scene.videoUrl}
            // The rendered clip is silent by construction (`-an` at conform
            // time); muting is belt and braces against a future change making
            // it speak over its own narration.
            muted
            style={{ width: "100%", height: "100%", objectFit: "contain" }}
          />
        </AbsoluteFill>
      ) : (
        <FallbackStage beat={beat} ageMs={ageMs} />
      )}

      {/* Lower third: the beat's own label, over the picture rather than
          instead of it. */}
      {scene.videoUrl && beat && (
        <div
          key={`${scene.id}-${beat.timeMs}`}
          style={{
            position: "absolute",
            bottom: 104,
            left: 48,
            right: 48,
            textAlign: "center",
            fontSize: labelFontSize(beat.highlightText),
            fontWeight: 700,
            lineHeight: 1.3,
            textShadow: "0 2px 12px rgba(0,0,0,0.55)",
            opacity: interpolate(ageMs, [0, 250], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }),
          }}
        >
          {beat.highlightText}
        </div>
      )}
    </AbsoluteFill>
  );
}

/* ── Captions ──────────────────────────────────────────────────────────────*/

function Captions({ timestamps, currentMs }: { timestamps: WordTiming[]; currentMs: number }) {
  const activeIndex = timestamps.findIndex((w) => currentMs >= w.startMs && currentMs < w.endMs);
  const windowStart = activeIndex === -1 ? 0 : Math.max(0, activeIndex - Math.floor(CAPTION_WINDOW / 2));
  const visible = timestamps.slice(windowStart, windowStart + CAPTION_WINDOW);

  return (
    <div
      style={{
        position: "absolute",
        bottom: 40,
        left: 0,
        right: 0,
        textAlign: "center",
        padding: "0 56px",
        fontSize: 20,
        lineHeight: 1.6,
      }}
    >
      {visible.map((w, i) => {
        const globalIndex = windowStart + i;
        const isActive = globalIndex === activeIndex;
        return (
          <span
            key={globalIndex}
            style={{
              marginRight: 6,
              color: isActive ? "#E8A33D" : "rgba(246,245,241,0.6)",
              fontWeight: isActive ? 700 : 400,
            }}
          >
            {w.word}
          </span>
        );
      })}
    </div>
  );
}

/* ── Legacy replay ─────────────────────────────────────────────────────────
 * Everything below renders a VIDEO turn stored before the Manim pipeline: one
 * narration track and a list of `visualCues`, some carrying an SVG diagram that
 * animates off `window.shikkhaRender(t)`.
 *
 * Kept because a student's history still holds those turns, and dropping them
 * is a mistake this codebase has already made once. Note what is gone: the
 * `footageMs` shift. Old lessons therefore replay BETTER than they played when
 * they were new — the drift was in the offset, not in the scripts.
 */

interface LegacyScene {
  id: string;
  cues: VisualCue[];
  canvasHtml?: string;
}

export function groupIntoScenes(cues: VisualCue[]): LegacyScene[] {
  const scenes: LegacyScene[] = [];

  for (const cue of cues) {
    const last = scenes[scenes.length - 1];
    const startsNew = !last || Boolean(cue.canvasHtml) || (Boolean(cue.sceneId) && cue.sceneId !== last.id);

    if (startsNew) {
      scenes.push({ id: cue.sceneId || `scene-${scenes.length}`, cues: [cue], canvasHtml: cue.canvasHtml });
    } else {
      last.cues.push(cue);
      if (!last.canvasHtml && cue.canvasHtml) last.canvasHtml = cue.canvasHtml;
    }
  }

  return scenes;
}

/** How far through its own scene the playhead is, 0→1 — the `t` handed to `shikkhaRender`. */
export function sceneProgress(scenes: LegacyScene[], sceneIndex: number, currentMs: number, audioEndMs: number): number {
  const scene = scenes[sceneIndex];
  if (!scene) return 0;

  const start = sceneIndex === 0 ? 0 : scene.cues[0]?.timeMs ?? 0;
  const next = scenes[sceneIndex + 1];
  const end = next?.cues[0]?.timeMs ?? Math.max(audioEndMs, start + 1);
  const span = end - start;
  if (span <= 0) return 0;

  return Math.min(1, Math.max(0, (currentMs - start) / span));
}

const FRAME_CLOCK_PREAMBLE = `
<script>
(function () {
  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.v !== 1 || d.type !== "shikkha:frame") return;
    try {
      if (typeof window.shikkhaRender === "function") window.shikkhaRender(d.t);
    } catch (err) {}
  });
})();
</script>`;

/**
 * A legacy scene's diagram. Model-generated markup, so it renders inside a
 * sandboxed iframe (`sandbox="allow-scripts"`, no `allow-same-origin`) — the
 * same isolation VisualSandbox uses for chat widgets. There is no "trusted
 * because it came from the video path" exception.
 */
function SceneDiagram({ html, transform, t }: { html: string; transform: string; t: number }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const srcDoc = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; padding: 0; background: transparent; height: 100%; }
      body { display: flex; align-items: center; justify-content: center; }
      svg, canvas { max-width: 100%; max-height: 100%; height: auto; }
    </style>
    ${FRAME_CLOCK_PREAMBLE}
  </head>
  <body>${buildSandboxBody(html)}</body>
</html>`;

  // Remotion re-renders per frame, so this effect IS the frame loop. Posting
  // unconditionally rather than waiting for a readiness handshake: srcDoc
  // scripts run before React attaches the parent listener, so a ready signal
  // races and is missed — a message sent too early is simply dropped and the
  // next frame lands ~33ms later.
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage({ v: 1, type: "shikkha:frame", t }, "*");
  }, [t]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transform,
        transformOrigin: "center center",
      }}
    >
      <iframe
        ref={frameRef}
        title="Lesson diagram"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        onLoad={() =>
          frameRef.current?.contentWindow?.postMessage({ v: 1, type: "shikkha:frame", t: tRef.current }, "*")
        }
        style={{ width: "100%", height: "100%", border: "none", background: "transparent" }}
      />
    </div>
  );
}

function LegacyTrack({
  audioUrl,
  visualCues,
  timestamps,
  reducedMotion,
}: {
  audioUrl: string;
  visualCues: VisualCue[];
  timestamps: WordTiming[];
  reducedMotion?: boolean;
}) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;

  const scenes = useMemo(() => groupIntoScenes(visualCues), [visualCues]);

  let sceneIndex = -1;
  let cue: VisualCue | null = null;
  let cueAgeMs = 0;
  let sceneAgeMs = 0;

  scenes.forEach((scene, index) => {
    for (const candidate of scene.cues) {
      if (candidate.timeMs > currentMs) return;
      sceneIndex = index;
      cue = candidate;
      cueAgeMs = currentMs - candidate.timeMs;
      sceneAgeMs = currentMs - (scene.cues[0]?.timeMs ?? candidate.timeMs);
    }
  });

  // Before the first cue fires, show the opening scene's picture with no label
  // yet — otherwise the lesson opens on a blank background while narration is
  // already talking.
  if (sceneIndex === -1 && scenes.length > 0) {
    sceneIndex = 0;
    sceneAgeMs = currentMs;
  }

  const scene = scenes[sceneIndex];
  const audioEndMs = timestamps.at(-1)?.endMs ?? 0;
  const t = sceneProgress(scenes, sceneIndex, currentMs, audioEndMs);
  const activeCue = cue as VisualCue | null;
  const transform = cameraTransform(
    activeCue ? { timeMs: activeCue.timeMs, highlightText: activeCue.highlightText, focusX: activeCue.focusX, focusY: activeCue.focusY } : null,
    cueAgeMs,
    reducedMotion,
  );
  const opacity = interpolate(sceneAgeMs, [0, 400], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <>
      <Audio src={audioUrl} />
      <AbsoluteFill style={{ padding: "72px 48px 132px", opacity }}>
        <div style={{ position: "relative", flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {scene?.canvasHtml ? (
            <SceneDiagram key={scene.id} html={scene.canvasHtml} transform={transform} t={t} />
          ) : (
            <FallbackStage
              beat={activeCue ? { timeMs: activeCue.timeMs, highlightText: activeCue.highlightText } : null}
              ageMs={cueAgeMs}
            />
          )}
        </div>
      </AbsoluteFill>

      {scene?.canvasHtml && activeCue && (
        <div
          style={{
            position: "absolute",
            bottom: 104,
            left: 48,
            right: 48,
            textAlign: "center",
            fontSize: labelFontSize(activeCue.highlightText),
            fontWeight: 700,
            lineHeight: 1.3,
            textShadow: "0 2px 12px rgba(0,0,0,0.55)",
          }}
        >
          {activeCue.highlightText}
        </div>
      )}
    </>
  );
}

/* ── The composition ───────────────────────────────────────────────────────*/

export interface LessonCompositionProps {
  title: string;
  timestamps: WordTiming[];
  /** UserSettings.reducedMotion — pins the camera and drops the beat motion. A scene's picture still shows: that's content, not motion. */
  reducedMotion?: boolean;
  /** The lesson, scene by scene. Empty on the legacy path. */
  scenes?: LessonSceneView[];
  /** A whole assembled lesson MP4, carrying its own audio — how a library-reused lesson plays. */
  lessonUrl?: string;
  /** Present only when replaying a turn stored before the Manim pipeline. */
  legacy?: { audioUrl: string; visualCues: VisualCue[] };
}

export default function LessonComposition({
  title,
  timestamps,
  reducedMotion,
  scenes = [],
  lessonUrl,
  legacy,
}: LessonCompositionProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentMs = (frame / fps) * 1000;
  const msToFrames = (ms: number): number => Math.round((ms / 1000) * fps);

  return (
    <AbsoluteFill style={{ backgroundColor: "#0F6B4C", fontFamily: "system-ui, sans-serif", color: "#F6F5F1" }}>
      {scenes.length > 0 ? (
        // Each scene owns its span and its audio. This is the entire timing
        // model — there is no shared clock to drift against.
        scenes.map((scene) => (
          <Sequence
            key={scene.id}
            from={msToFrames(scene.startMs)}
            durationInFrames={Math.max(1, msToFrames(scene.durationMs))}
          >
            <SceneStage scene={scene} reducedMotion={reducedMotion} />
          </Sequence>
        ))
      ) : lessonUrl ? (
        // A lesson replayed from the shared library: one finished MP4 that
        // already carries its narration, so it is NOT muted here.
        <AbsoluteFill style={{ backgroundColor: "#000" }}>
          <OffthreadVideo src={lessonUrl} style={{ width: "100%", height: "100%", objectFit: "contain" }} />
        </AbsoluteFill>
      ) : legacy ? (
        <LegacyTrack
          audioUrl={legacy.audioUrl}
          visualCues={legacy.visualCues}
          timestamps={timestamps}
          reducedMotion={reducedMotion}
        />
      ) : null}

      <div style={{ position: "absolute", top: 28, left: 0, right: 0, textAlign: "center", fontSize: 18, opacity: 0.7 }}>
        {title}
      </div>

      {/* Captions run off the lesson-wide manifest, so they are unaffected by
          the audio underneath being several files. An assembled MP4 has no
          manifest, and shows none. */}
      {timestamps.length > 0 && <Captions timestamps={timestamps} currentMs={currentMs} />}
    </AbsoluteFill>
  );
}
