import { describe, expect, it } from "vitest";
import {
  extractJsonPayload,
  parseOrchestratorResult,
  parseSuggestions,
  parseVisualHtml,
  resolveSceneIds,
} from "./orchestrator";
import type { VideoScript } from "./orchestrator";

/** An animated scene diagram: declares the frame-clock entry point the player drives. */
const ANIMATED = "<svg/><script>window.shikkhaRender=function(t){}<\/script>";

function cue(canvasHtml?: string) {
  return { timeMs: 0, animationType: "highlight", highlightText: "word", canvasHtml };
}

function videoScript(cues: ReturnType<typeof cue>[]): VideoScript {
  return { title: "t", narration: "n", accentLocale: "en-US", visualCues: cues };
}

/** A cue with an explicit scene tag — what the model emits when it opens a scene. */
function scened(sceneId: string | undefined, canvasHtml?: string) {
  return { timeMs: 0, animationType: "highlight", highlightText: "word", sceneId, canvasHtml };
}

describe("resolveSceneIds", () => {
  // The exact shape a real generated script came back in: the model tags the
  // cue that INTRODUCES a scene and leaves continuation cues untagged.
  it("carries a scene forward across the untagged continuation cues the model actually emits", () => {
    const resolved = resolveSceneIds([
      scened("cricket_field", "<svg/>"),
      scened(undefined),
      scened(undefined),
      scened("atmosphere", "<svg/>"),
      scened(undefined),
    ]);

    expect(resolved.map((c) => c.sceneId)).toEqual([
      "cricket_field",
      "cricket_field",
      "cricket_field",
      "atmosphere",
      "atmosphere",
    ]);
  });

  it("starts a new scene on a diagram even when the model reuses the same sceneId", () => {
    const resolved = resolveSceneIds([scened("s", "<svg/>"), scened(undefined), scened("s", "<svg/>")]);
    expect(new Set(resolved.map((c) => c.sceneId)).size).toBe(2);
  });

  it("gives leading untagged cues an id so they can still be grouped", () => {
    const resolved = resolveSceneIds([scened(undefined), scened(undefined)]);
    expect(resolved.every((c) => Boolean(c.sceneId))).toBe(true);
    expect(resolved[0]!.sceneId).toBe(resolved[1]!.sceneId);
  });

  it("never copies canvasHtml onto continuation cues — the client groups instead", () => {
    const resolved = resolveSceneIds([scened("s1", "<svg/>"), scened(undefined)]);
    expect(resolved[1]!.canvasHtml).toBeUndefined();
  });
});

describe("parseOrchestratorResult", () => {
  it("carries a VIDEO turn's brief through to the result", () => {
    const raw = JSON.stringify({
      responseType: "VIDEO",
      reasoning: "motion is the point here",
      content: "A real explanation of the concept.",
      videoBrief: {
        title: "পড়ন্ত বস্তুর বেগ",
        conceptKey: "অভিকর্ষজ ত্বরণে বেগ বাড়ে",
        goal: "কেন সব বস্তু একই হারে পড়ে",
        analogy: "ছাদ থেকে আম পড়া",
      },
    });

    const result = parseOrchestratorResult(raw);

    expect(result.responseType).toBe("VIDEO");
    expect(result.videoBrief?.conceptKey).toBe("অভিকর্ষজ ত্বরণে বেগ বাড়ে");
    expect(result.videoBrief?.analogy).toBe("ছাদ থেকে আম পড়া");
  });

  // Guardrail #9: a responseType that promises an artefact it doesn't have
  // must be downgraded, never shipped as a button that leads nowhere.
  it("downgrades a VIDEO turn with no usable brief to TEXT, keeping content as the answer", () => {
    const raw = JSON.stringify({
      responseType: "VIDEO",
      reasoning: "chose video",
      content: "A real explanation of the concept.",
      videoBrief: { title: "t" }, // no goal
    });

    const result = parseOrchestratorResult(raw);

    expect(result.responseType).toBe("TEXT");
    expect(result.content).toBe("A real explanation of the concept.");
    expect(result.videoBrief).toBeUndefined();
    expect(result.reasoning).toContain("fallback");
  });

  it("downgrades a VIDEO turn with no brief at all", () => {
    const raw = JSON.stringify({ responseType: "VIDEO", reasoning: "r", content: "fallback text" });
    const result = parseOrchestratorResult(raw);
    expect(result.responseType).toBe("TEXT");
    expect(result.content).toBe("fallback text");
  });

  it("no longer gates VIDEO on diagram coverage — the director writes the scenes now", () => {
    // This would have been rejected by the old cue/coverage rules. Those gates
    // moved to where quality is now decided: the renderer either produces a
    // scene or that one scene falls back (PLAN.md §8).
    const raw = JSON.stringify({
      responseType: "VIDEO",
      reasoning: "r",
      content: "c",
      videoBrief: { title: "t", conceptKey: "k", goal: "g" },
    });
    expect(parseOrchestratorResult(raw).responseType).toBe("VIDEO");
  });

  it("downgrades VIDEO with a structurally invalid videoScript", () => {
    const raw = JSON.stringify({
      responseType: "VIDEO",
      reasoning: "chose video",
      content: "fallback text",
      videoScript: { title: "t" }, // missing required fields
    });

    const result = parseOrchestratorResult(raw);

    expect(result.responseType).toBe("TEXT");
    expect(result.content).toBe("fallback text");
  });

  it("passes TEXT through unchanged", () => {
    const raw = JSON.stringify({ responseType: "TEXT", reasoning: "r", content: "c" });
    const result = parseOrchestratorResult(raw);
    expect(result.responseType).toBe("TEXT");
    expect(result.content).toBe("c");
  });

  it("degrades unparseable JSON to TEXT instead of throwing", () => {
    const result = parseOrchestratorResult("not json");
    expect(result.responseType).toBe("TEXT");
    expect(result.content.length).toBeGreaterThan(0);
  });

  // The regression this whole change exists for: visualHtml was declared on
  // the result, declared in RESPONSE_JSON_SCHEMA and prompted for, but never
  // read here — so every CANVAS turn reached the UI with no visual at all.
  it("carries visualHtml out of a CANVAS response", () => {
    const raw = JSON.stringify({
      responseType: "CANVAS",
      reasoning: "r",
      content: "explanation",
      visualHtml: "<svg viewBox='0 0 10 10'><circle cx='5' cy='5' r='4'/></svg>",
    });

    const result = parseOrchestratorResult(raw);

    expect(result.responseType).toBe("CANVAS");
    expect(result.visualHtml).toContain("<svg");
  });

  it("carries suggestions out of any response type", () => {
    const raw = JSON.stringify({
      responseType: "TEXT",
      reasoning: "r",
      content: "c",
      suggestions: ["এটা কি সব ক্ষেত্রেই খাটে?", "শেষ ধাপটা আরেকবার বলবে?"],
    });

    expect(parseOrchestratorResult(raw).suggestions).toEqual([
      "এটা কি সব ক্ষেত্রেই খাটে?",
      "শেষ ধাপটা আরেকবার বলবে?",
    ]);
  });

  it("downgrades a CANVAS with no usable visual to TEXT rather than promising an empty panel", () => {
    const raw = JSON.stringify({ responseType: "CANVAS", reasoning: "r", content: "c" });
    const result = parseOrchestratorResult(raw);

    expect(result.responseType).toBe("TEXT");
    expect(result.visualHtml).toBeUndefined();
    expect(result.reasoning).toContain("fallback");
  });

  it("salvages a CANVAS visual the model inlined into content against instructions", () => {
    const raw = JSON.stringify({
      responseType: "CANVAS",
      reasoning: "r",
      content: "আগে দেখো:\n\n```html\n<svg viewBox='0 0 10 10'><rect width='10' height='10'/></svg>\n```",
    });

    const result = parseOrchestratorResult(raw);

    expect(result.responseType).toBe("CANVAS");
    expect(result.visualHtml).toContain("<svg");
    // The markup must be lifted OUT of the prose, or it renders as escaped text in the bubble.
    expect(result.content).not.toContain("<svg");
  });

  it("parses a fenced ```json payload instead of dumping raw JSON into the chat", () => {
    const inner = JSON.stringify({ responseType: "TEXT", reasoning: "r", content: "আসল উত্তর" });
    const result = parseOrchestratorResult("```json\n" + inner + "\n```");

    expect(result.responseType).toBe("TEXT");
    expect(result.content).toBe("আসল উত্তর");
  });

  it("never leaks unparseable model output into content", () => {
    const result = parseOrchestratorResult("<<<garbage not json at all>>>");
    expect(result.content).not.toContain("garbage");
  });
});

describe("parseVisualHtml", () => {
  it("rejects markup with no drawable root tag", () => {
    expect(parseVisualHtml("just a sentence")).toBeUndefined();
  });

  it("rejects a runaway generation instead of persisting it", () => {
    expect(parseVisualHtml(`<svg>${"x".repeat(30_000)}</svg>`)).toBeUndefined();
  });

  it("accepts a real widget", () => {
    expect(parseVisualHtml("  <canvas id='c'></canvas>  ")).toBe("<canvas id='c'></canvas>");
  });
});

describe("parseSuggestions", () => {
  it("dedupes, trims and caps at three", () => {
    expect(parseSuggestions([" a ", "a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
  });

  it("drops an over-long 'suggestion' — that's the model writing prose, not a chip", () => {
    expect(parseSuggestions(["x".repeat(200)])).toBeUndefined();
  });

  it("returns undefined for a non-array so callers fall back to the static pills", () => {
    expect(parseSuggestions("nope")).toBeUndefined();
  });
});

describe("extractJsonPayload", () => {
  it("unwraps a fenced block", () => {
    expect(extractJsonPayload('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("finds the brace span inside chatter", () => {
    expect(extractJsonPayload('Sure! {"a":1} hope that helps')).toBe('{"a":1}');
  });
});
