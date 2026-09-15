import { describe, expect, it } from "vitest";
import { buildWindows, sampleWindows, sanitizePrerequisites } from "./synthesis.service";

describe("buildWindows", () => {
  it("packs chunks into one window until the char budget would be exceeded", () => {
    const chunks = [
      { content: "a".repeat(3000), page: 1 },
      { content: "b".repeat(3000), page: 2 },
      { content: "c".repeat(3000), page: 3 }, // pushes past the ~6000-char budget, starts a new window
    ];
    const windows = buildWindows(chunks);
    expect(windows.length).toBe(2);
    expect(windows[0]!.pages).toEqual([1, 2]);
    expect(windows[1]!.pages).toEqual([3]);
  });

  it("never splits a single chunk across windows even if it alone exceeds the budget", () => {
    const chunks = [{ content: "x".repeat(9000), page: 1 }];
    const windows = buildWindows(chunks);
    expect(windows.length).toBe(1);
    expect(windows[0]!.text.length).toBe(9000);
  });

  it("handles chunks with no page number", () => {
    const chunks = [{ content: "text", page: null }];
    const windows = buildWindows(chunks);
    expect(windows[0]!.pages).toEqual([]);
  });
});

describe("sampleWindows", () => {
  it("returns everything when under the max", () => {
    const windows = [{ text: "a", pages: [1] }, { text: "b", pages: [2] }];
    expect(sampleWindows(windows, 5)).toEqual(windows);
  });

  it("always keeps the first and last window when sampling down", () => {
    const windows = Array.from({ length: 10 }, (_, i) => ({ text: `w${i}`, pages: [i] }));
    const sampled = sampleWindows(windows, 3);
    expect(sampled[0]).toBe(windows[0]);
    expect(sampled[sampled.length - 1]).toBe(windows[9]);
    expect(sampled.length).toBeLessThanOrEqual(3);
  });
});

describe("sanitizePrerequisites", () => {
  it("keeps a valid forward reference to an earlier level", () => {
    const levels = [
      { tempKey: "n1", title: "A", description: "", prerequisiteKeys: [] },
      { tempKey: "n2", title: "B", description: "", prerequisiteKeys: ["n1"] },
    ];
    expect(sanitizePrerequisites(levels)[1]!.prerequisiteKeys).toEqual(["n1"]);
  });

  it("drops a self-reference", () => {
    const levels = [{ tempKey: "n1", title: "A", description: "", prerequisiteKeys: ["n1"] }];
    expect(sanitizePrerequisites(levels)[0]!.prerequisiteKeys).toEqual([]);
  });

  it("drops a reference to an unknown key", () => {
    const levels = [{ tempKey: "n1", title: "A", description: "", prerequisiteKeys: ["ghost"] }];
    expect(sanitizePrerequisites(levels)[0]!.prerequisiteKeys).toEqual([]);
  });

  it("drops a reference to a later level (would form a cycle)", () => {
    const levels = [
      { tempKey: "n1", title: "A", description: "", prerequisiteKeys: ["n2"] },
      { tempKey: "n2", title: "B", description: "", prerequisiteKeys: [] },
    ];
    expect(sanitizePrerequisites(levels)[0]!.prerequisiteKeys).toEqual([]);
  });
});
