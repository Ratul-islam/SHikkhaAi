import { describe, expect, it } from "vitest";
import { alignCues } from "./cue-align.service";
import type { VisualCue } from "../chat/orchestrator";
import type { WordTiming } from "../speech/edge-speech.service";

function word(text: string, startMs: number, endMs: number): WordTiming {
  return { word: text, startMs, endMs };
}

describe("alignCues", () => {
  it("aligns a cue to the real timestamp of its highlighted word", () => {
    const timestamps = [word("The", 0, 200), word("cat", 200, 500), word("sat", 500, 800)];
    const cues: VisualCue[] = [{ timeMs: 9999, animationType: "highlight", highlightText: "cat sat" }];

    const aligned = alignCues(cues, timestamps);

    expect(aligned[0]!.timeMs).toBe(200); // "cat" starts at 200ms, not the model's 9999ms guess
  });

  it("picks the occurrence closest to the model's original guess when a word repeats", () => {
    const timestamps = [
      word("force", 0, 200),
      word("is", 200, 300),
      word("mass", 300, 500),
      word("force", 5000, 5200),
      word("times", 5200, 5400),
      word("acceleration", 5400, 5700),
    ];
    const cues: VisualCue[] = [{ timeMs: 4800, animationType: "highlight", highlightText: "force times" }];

    const aligned = alignCues(cues, timestamps);

    expect(aligned[0]!.timeMs).toBe(5000); // closer to the 4800ms guess than the 0ms occurrence
  });

  it("enforces monotonic ordering even when matches would otherwise go backwards", () => {
    const timestamps = [word("alpha", 1000, 1200), word("beta", 100, 300)];
    const cues: VisualCue[] = [
      { timeMs: 0, animationType: "highlight", highlightText: "alpha" },
      { timeMs: 500, animationType: "highlight", highlightText: "beta" }, // matches at 100ms, before the first cue
    ];

    const aligned = alignCues(cues, timestamps);

    expect(aligned[0]!.timeMs).toBe(1000);
    expect(aligned[1]!.timeMs).toBeGreaterThanOrEqual(aligned[0]!.timeMs);
  });

  it("falls back to the model's own guess, clamped to audio duration, when no word matches", () => {
    const timestamps = [word("hello", 0, 200)];
    const cues: VisualCue[] = [{ timeMs: 99999, animationType: "highlight", highlightText: "xyzzy" }];

    const aligned = alignCues(cues, timestamps);

    expect(aligned[0]!.timeMs).toBeLessThanOrEqual(200); // clamped to the real audio's end
  });

  it("returns cues unchanged when there is no timestamp data at all", () => {
    const cues: VisualCue[] = [{ timeMs: 42, animationType: "highlight", highlightText: "anything" }];
    expect(alignCues(cues, [])).toEqual(cues);
  });

  it("preserves canvasHtml through alignment", () => {
    const timestamps = [word("diagram", 0, 300)];
    const cues: VisualCue[] = [
      { timeMs: 0, animationType: "diagram-reveal", highlightText: "diagram", canvasHtml: "<svg></svg>" },
    ];

    const aligned = alignCues(cues, timestamps);

    expect(aligned[0]!.canvasHtml).toBe("<svg></svg>");
  });
});
