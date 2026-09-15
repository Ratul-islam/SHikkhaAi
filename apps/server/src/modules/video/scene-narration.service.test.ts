import { describe, expect, it } from "vitest";
import { buildTimeline, concatTimestamps, placeBeats, type SceneNarration } from "./scene-narration.service";
import {
  parseDirectedScript,
  isDirectedScript,
  estimateSecondsFromText,
  splitMathAndLabels,
} from "./director.schema";
import type { DirectedScene } from "./director.schema";

/**
 * These test the sync guarantee itself (PLAN.md §1).
 *
 * The old pipeline's defect was not a bad constant — it was that scene timing
 * was DERIVED from a separate audio track by word matching, and then shifted
 * again by the footage length, so the two could disagree. What is asserted here
 * is the property that replaced it: a scene occupies exactly its own narration,
 * and a beat can never leave the scene it belongs to.
 */

function narration(sceneId: string, durationMs: number, words: string[] = ["a", "b"]): SceneNarration {
  const step = Math.floor(durationMs / words.length);
  return {
    sceneId,
    audioUrl: `/uploads/${sceneId}.wav`,
    durationMs,
    timestamps: words.map((word, i) => ({ word, startMs: i * step, endMs: (i + 1) * step })),
    costUsd: 0,
  };
}

describe("buildTimeline", () => {
  it("starts each scene exactly where the previous one's audio ended", () => {
    const { timings, totalMs } = buildTimeline([
      narration("a", 8000),
      narration("b", 12500),
      narration("c", 6250),
    ]);

    expect(timings).toEqual([
      { sceneId: "a", startMs: 0, durationMs: 8000 },
      { sceneId: "b", startMs: 8000, durationMs: 12500 },
      { sceneId: "c", startMs: 20500, durationMs: 6250 },
    ]);
    expect(totalMs).toBe(26750);
  });

  it("leaves no gap or overlap anywhere in the lesson", () => {
    const { timings, totalMs } = buildTimeline([
      narration("a", 7431),
      narration("b", 9117),
      narration("c", 4002),
      narration("d", 11890),
    ]);

    // The property in one line: every scene's end is the next scene's start.
    for (let i = 1; i < timings.length; i++) {
      expect(timings[i]!.startMs).toBe(timings[i - 1]!.startMs + timings[i - 1]!.durationMs);
    }
    expect(timings.at(-1)!.startMs + timings.at(-1)!.durationMs).toBe(totalMs);
  });

  it("handles a single scene", () => {
    const { timings, totalMs } = buildTimeline([narration("only", 5000)]);
    expect(timings).toEqual([{ sceneId: "only", startMs: 0, durationMs: 5000 }]);
    expect(totalMs).toBe(5000);
  });

  it("is empty for no scenes rather than throwing", () => {
    expect(buildTimeline([])).toEqual({ timings: [], totalMs: 0 });
  });
});

describe("concatTimestamps", () => {
  it("offsets each scene's words onto the lesson timeline", () => {
    const narrations = [narration("a", 1000, ["one", "two"]), narration("b", 1000, ["three", "four"])];
    const { timings } = buildTimeline(narrations);
    const manifest = concatTimestamps(narrations, timings);

    expect(manifest.map((w) => w.word)).toEqual(["one", "two", "three", "four"]);
    // Scene b's first word sits at its scene start, not back at zero.
    expect(manifest[2]!.startMs).toBe(1000);
    expect(manifest[3]!.endMs).toBe(2000);
  });

  it("produces a strictly non-decreasing timeline, which is what captions assume", () => {
    const narrations = [narration("a", 3000, ["x", "y", "z"]), narration("b", 2000, ["p", "q"])];
    const { timings } = buildTimeline(narrations);
    const manifest = concatTimestamps(narrations, timings);

    for (let i = 1; i < manifest.length; i++) {
      expect(manifest[i]!.startMs).toBeGreaterThanOrEqual(manifest[i - 1]!.startMs);
    }
  });
});

describe("placeBeats", () => {
  const scene = (beats: DirectedScene["beats"]): DirectedScene => ({
    id: "s",
    role: "MECHANISM",
    narration: "n",
    visualBrief: "v",
    labels: [],
    mathTex: [],
    beats,
  });

  it("maps a beat's fraction onto real time inside its scene", () => {
    const placed = placeBeats(scene([{ at: 0.5, highlightText: "মাঝখানে" }]), {
      sceneId: "s",
      startMs: 10_000,
      durationMs: 8000,
    });
    expect(placed[0]!.timeMs).toBe(14_000);
  });

  it("clamps a beat that would escape its own scene", () => {
    // The guarantee that makes a mixed Manim/SVG lesson stay in sync: however
    // the director numbered a beat, it cannot land in a neighbouring scene.
    const placed = placeBeats(
      scene([
        { at: -3, highlightText: "before" },
        { at: 9, highlightText: "after" },
      ]),
      { sceneId: "s", startMs: 5000, durationMs: 4000 },
    );

    expect(placed[0]!.timeMs).toBe(5000);
    expect(placed[1]!.timeMs).toBe(9000);
  });

  it("carries the focal point through for the camera", () => {
    const placed = placeBeats(scene([{ at: 0.25, highlightText: "h", focusX: 0.8, focusY: 0.2 }]), {
      sceneId: "s",
      startMs: 0,
      durationMs: 4000,
    });
    expect(placed[0]).toMatchObject({ timeMs: 1000, focusX: 0.8, focusY: 0.2 });
  });
});

describe("parseDirectedScript", () => {
  const scene = (over: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
    id: "s1",
    role: "MECHANISM",
    narration: "এটি একটি যথেষ্ট লম্বা বর্ণনা যা একটি দৃশ্যের জন্য যথেষ্ট।",
    visualBrief: "Draw a block on a ramp with a force arrow.",
    labels: ["বল"],
    mathTex: ["F = ma"],
    beats: [{ at: 0.2, highlightText: "বল" }],
    ...over,
  });

  it("accepts a well-formed script", () => {
    const result = parseDirectedScript({
      title: "ঘর্ষণ",
      conceptKey: "ঘর্ষণ বল",
      approach: "One ramp that becomes a free-body diagram.",
      scenes: [scene({ id: "a" }), scene({ id: "b" })],
    });

    expect(isDirectedScript(result)).toBe(true);
    if (!isDirectedScript(result)) return;
    expect(result.scenes).toHaveLength(2);
  });

  it("uniquifies repeated scene ids, which the model does emit", () => {
    // The same failure resolveSceneIds was written for on the legacy path:
    // two different pictures sharing an id get silently merged downstream.
    const result = parseDirectedScript({
      title: "t",
      conceptKey: "k",
      approach: "a",
      scenes: [scene({ id: "s" }), scene({ id: "s" }), scene({ id: "s" })],
    });

    expect(isDirectedScript(result)).toBe(true);
    if (!isDirectedScript(result)) return;
    expect(new Set(result.scenes.map((s) => s.id)).size).toBe(3);
  });

  it("sorts beats ascending so a later beat can't appear to fire first", () => {
    const result = parseDirectedScript({
      title: "t",
      conceptKey: "k",
      approach: "a",
      scenes: [
        scene({
          beats: [
            { at: 0.9, highlightText: "শেষ" },
            { at: 0.1, highlightText: "শুরু" },
          ],
        }),
        scene({ id: "b" }),
      ],
    });

    expect(isDirectedScript(result)).toBe(true);
    if (!isDirectedScript(result)) return;
    expect(result.scenes[0]!.beats.map((b) => b.at)).toEqual([0.1, 0.9]);
  });

  it("rejects a script with too few usable scenes rather than shipping a stub", () => {
    const result = parseDirectedScript({ title: "t", conceptKey: "k", approach: "a", scenes: [scene()] });
    expect(isDirectedScript(result)).toBe(false);
  });

  it("drops a scene whose narration is too short to be a scene", () => {
    const result = parseDirectedScript({
      title: "t",
      conceptKey: "k",
      approach: "a",
      scenes: [scene({ narration: "হুম" }), scene({ id: "b" }), scene({ id: "c" })],
    });
    expect(isDirectedScript(result)).toBe(true);
    if (!isDirectedScript(result)) return;
    expect(result.scenes).toHaveLength(2);
  });

  it("returns a reason rather than throwing on junk", () => {
    expect(isDirectedScript(parseDirectedScript(null))).toBe(false);
    expect(isDirectedScript(parseDirectedScript({ title: "only" }))).toBe(false);
    expect(isDirectedScript(parseDirectedScript("nope"))).toBe(false);
  });
});

describe("estimateSecondsFromText", () => {
  it("scales with length, for the pre-narration ceiling check", () => {
    expect(estimateSecondsFromText("x".repeat(120))).toBe(10);
    expect(estimateSecondsFromText("")).toBe(0);
  });
});

describe("splitMathAndLabels", () => {
  it("keeps real LaTeX in mathTex", () => {
    const r = splitMathAndLabels(["v = u + at", "F_{net}"], []);
    expect(r.mathTex).toEqual(["v = u + at", "F_{net}"]);
    expect(r.labels).toEqual([]);
  });

  it("moves Bangla out of mathTex and into labels", () => {
    // The director is told not to do this and does it anyway; passing it
    // through meant the scene prompt literally instructed the generator to
    // write MathTex("বেগ"), which LaTeX cannot set at all — so the validator
    // rejected it, the retry regenerated from the same instruction, and it
    // failed again identically. The commonest stubborn failure in real output.
    const r = splitMathAndLabels(["বেগ", "a = 2"], ["ত্বরণ"]);
    expect(r.mathTex).toEqual(["a = 2"]);
    expect(r.labels).toEqual(["ত্বরণ", "বেগ"]);
  });

  it("does not duplicate a term the director listed in both fields", () => {
    const r = splitMathAndLabels(["বেগ"], ["বেগ"]);
    expect(r.labels).toEqual(["বেগ"]);
  });

  it("moves a mixed Bangla/Latin fragment, since LaTeX still cannot set it", () => {
    const r = splitMathAndLabels(["বেগ = 5 m/s"], []);
    expect(r.mathTex).toEqual([]);
    expect(r.labels).toEqual(["বেগ = 5 m/s"]);
  });
});
