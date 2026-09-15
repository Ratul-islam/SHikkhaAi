import { describe, expect, it } from "vitest";
import { concatListLine, planConform, MAX_RETIME_RATIO } from "./ffmpeg.service";

/**
 * The conform planner is the keystone of the sync guarantee (PLAN.md §7).
 *
 * Everything upstream ASKS the model for the right duration; this is the step
 * that stops asking and makes it true. So what matters here is that every
 * possible input maps to some action that ends at the target — there is no
 * "close enough, ship it" branch.
 */

describe("planConform", () => {
  it("does nothing when the render already matches", () => {
    expect(planConform(8000, 8000).action).toBe("none");
  });

  it("ignores a sub-frame difference", () => {
    // Under ~1 frame at 30fps there is nothing a re-encode could fix.
    expect(planConform(8000, 8020).action).toBe("none");
    expect(planConform(8020, 8000).action).toBe("none");
  });

  it("holds the last frame when the animation finishes early", () => {
    // The common case, and the safe one: never distorts the motion, and reads
    // as a beat of stillness while the narration finishes its sentence.
    expect(planConform(6000, 9000).action).toBe("pad");
  });

  it("holds the last frame even for a very short render", () => {
    expect(planConform(500, 12_000).action).toBe("pad");
  });

  it("gently retimes a slight overrun", () => {
    const { action, ratio } = planConform(8500, 8000);
    expect(action).toBe("retime");
    expect(ratio).toBeLessThan(1);
    expect(ratio).toBeGreaterThan(1 - MAX_RETIME_RATIO);
  });

  it("trims rather than distorting a bad overrun", () => {
    // Slowing a 30%-long scene to fit would look broken; cutting is honest.
    expect(planConform(20_000, 8000).action).toBe("trim");
  });

  it("puts the retime/trim boundary exactly at the stated ratio", () => {
    const target = 10_000;
    const justInside = target / (1 - MAX_RETIME_RATIO + 0.001);
    const justOutside = target / (1 - MAX_RETIME_RATIO - 0.001);
    expect(planConform(justInside, target).action).toBe("retime");
    expect(planConform(justOutside, target).action).toBe("trim");
  });

  it("refuses to plan against nonsense rather than emitting a bad filter", () => {
    expect(planConform(0, 8000).action).toBe("none");
    expect(planConform(8000, 0).action).toBe("none");
    expect(planConform(-1, 8000).action).toBe("none");
  });
});

describe("concatListLine", () => {
  it("quotes a plain path", () => {
    expect(concatListLine("/tmp/a/scene-0.mp4")).toBe("file '/tmp/a/scene-0.mp4'");
  });

  it("escapes a quote in the path, which would otherwise end the filename early", () => {
    expect(concatListLine("/tmp/it's/scene.mp4")).toBe("file '/tmp/it'\\''s/scene.mp4'");
  });
});
