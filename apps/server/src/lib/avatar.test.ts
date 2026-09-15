import { describe, expect, it } from "vitest";
import { generateDefaultAvatar } from "./avatar";

describe("generateDefaultAvatar", () => {
  it("is deterministic for the same seed", () => {
    const a = generateDefaultAvatar("user-123", "Rafiul Islam");
    const b = generateDefaultAvatar("user-123", "Rafiul Islam");
    expect(a).toBe(b);
  });

  it("produces a different avatar for a different seed (regenerate)", () => {
    const a = generateDefaultAvatar("seed-1", "Rafiul Islam");
    const b = generateDefaultAvatar("seed-2", "Rafiul Islam");
    expect(a).not.toBe(b);
  });

  it("returns a valid SVG data URI", () => {
    const avatar = generateDefaultAvatar("seed", "Rafiul Islam");
    expect(avatar.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const decoded = Buffer.from(avatar.split(",")[1]!, "base64").toString("utf8");
    expect(decoded).toContain("<svg");
    expect(decoded).toContain("RI"); // initials from "Rafiul Islam"
  });

  it("falls back to a single '?' for a name with no usable characters", () => {
    const avatar = generateDefaultAvatar("seed", "   ");
    const decoded = Buffer.from(avatar.split(",")[1]!, "base64").toString("utf8");
    expect(decoded).toContain(">?<");
  });
});
