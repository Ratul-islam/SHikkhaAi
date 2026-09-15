import { describe, expect, it } from "vitest";
import { dateKeyInTimezone } from "./timezone";

describe("dateKeyInTimezone", () => {
  it("formats as YYYY-MM-DD", () => {
    const date = new Date("2026-03-15T12:00:00Z");
    expect(dateKeyInTimezone(date, "UTC")).toBe("2026-03-15");
  });

  it("a timestamp near midnight UTC can fall on a different calendar day in another timezone", () => {
    // 2026-03-15T23:30:00Z is already 2026-03-16 in Asia/Dhaka (UTC+6) —
    // exactly the scenario streak.ts exists to get right.
    const date = new Date("2026-03-15T23:30:00Z");
    expect(dateKeyInTimezone(date, "UTC")).toBe("2026-03-15");
    expect(dateKeyInTimezone(date, "Asia/Dhaka")).toBe("2026-03-16");
  });

  it("falls back to UTC for an invalid timezone name instead of throwing", () => {
    const date = new Date("2026-03-15T12:00:00Z");
    expect(() => dateKeyInTimezone(date, "Not/A_Real_Zone")).not.toThrow();
    expect(dateKeyInTimezone(date, "Not/A_Real_Zone")).toBe("2026-03-15");
  });
});
