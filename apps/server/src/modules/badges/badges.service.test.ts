import { describe, expect, it } from "vitest";
import { BADGE_DEFINITIONS } from "./badges.service";

describe("BADGE_DEFINITIONS catalog", () => {
  it("every definition's key matches its own map key", () => {
    for (const [mapKey, definition] of Object.entries(BADGE_DEFINITIONS)) {
      expect(definition.key).toBe(mapKey);
    }
  });

  it("every definition has a non-empty title, description, and a single-emoji icon", () => {
    for (const definition of Object.values(BADGE_DEFINITIONS)) {
      expect(definition.title.length).toBeGreaterThan(0);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.icon.length).toBeGreaterThan(0);
    }
  });

  it("no key collides with the dynamic CHAPTER_CLEARED: prefix", () => {
    for (const key of Object.keys(BADGE_DEFINITIONS)) {
      expect(key.startsWith("CHAPTER_CLEARED:")).toBe(false);
    }
  });
});
