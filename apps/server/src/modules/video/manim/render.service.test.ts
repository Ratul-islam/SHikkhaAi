import { describe, expect, it } from "vitest";
import { renderCacheKey, validateSceneSource, checkRenderHealth, renderScene } from "./render.service";

/**
 * The sandbox's tests are REJECTION tests first (PLAN.md §6).
 *
 * These run the real validator against the real interpreter rather than
 * mocking it, because what is being asserted is a security property and a
 * mocked allowlist proves nothing. They need the venv from
 * `npm run setup:manim`; without it `checkRenderHealth` reports unhealthy and
 * the render cases skip, while the validator cases still run — validate.py
 * depends on nothing outside the standard library precisely so that a broken
 * venv can still REJECT code.
 */

const scene = (body: string): string => `from manim import *\n\nclass LessonScene(Scene):\n    def construct(self):\n${body}`;

const BENIGN = scene(
  [
    '        title = Text("বল", font="Noto Sans Bengali", font_size=36)',
    '        eq = MathTex(r"F = ma")',
    "        self.play(Write(title), run_time=SCENE_DURATION * 0.5)",
    "        self.wait(SCENE_DURATION * 0.5)",
  ].join("\n"),
);

describe("validateSceneSource — hostile input", () => {
  const rejected: [name: string, source: string][] = [
    ["a plain os import", `import os\n${scene("        os.system('id')")}`],
    ["an os.path import", `import os.path\n${scene("        pass")}`],
    ["from-import of a banned module", `from subprocess import run\n${scene("        pass")}`],
    ["a relative import", `from . import secrets\n${scene("        pass")}`],
    ["importlib", `from importlib import import_module\n${scene("        pass")}`],
    ["the __subclasses__ escape", scene("        x = ().__class__.__bases__[0].__subclasses__()")],
    ["a __globals__ walk", scene("        g = (lambda: 0).__globals__")],
    ["getattr, which defeats a name filter", scene('        c = getattr((), "__cl" + "ass__")')],
    ["open()", scene('        data = open("/etc/passwd").read()')],
    ["exec()", scene('        exec("import os")')],
    ["eval()", scene('        eval("1+1")')],
    ["__import__", scene('        m = __import__("os")')],
    ["breakpoint()", scene("        breakpoint()")],
    ["an async construct", 'from manim import *\n\nclass LessonScene(Scene):\n    async def construct(self):\n        pass'],
    ["a custom decorator, which runs at class-definition time", 'from manim import *\n\ndef hook(f):\n    return f\n\nclass LessonScene(Scene):\n    @hook\n    def construct(self):\n        pass'],
    ["a yield, which is not animation machinery", scene("        yield 1")],
    ["a global statement", scene("        global SCENE_DURATION")],
  ];

  for (const [name, source] of rejected) {
    it(`rejects ${name}`, async () => {
      const result = await validateSceneSource(source);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  }

  it("rejects a syntax error without throwing", async () => {
    const result = await validateSceneSource("class LessonScene(Scene)\n    def construct(self)");
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/syntax error/);
  });
});

describe("validateSceneSource — the Bangla/LaTeX split (PLAN.md §5.1)", () => {
  it("rejects Bangla inside MathTex, which would fail minutes later at render time", async () => {
    const result = await validateSceneSource(scene('        m = MathTex("বেগ = ৫")'));
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Bangla/);
  });

  it("rejects Bangla hidden in an f-string passed to MathTex", async () => {
    const result = await validateSceneSource(scene('        m = MathTex(f"বেগ {1}")'));
    expect(result.ok).toBe(false);
  });

  it("accepts Bangla in Text(), which is the Pango path that can render it", async () => {
    const result = await validateSceneSource(scene('        t = Text("বেগ", font="Noto Sans Bengali")'));
    expect(result.ok).toBe(true);
  });
});

describe("validateSceneSource — the scene class contract", () => {
  it("accepts an ordinary scene", async () => {
    const result = await validateSceneSource(BENIGN);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects a differently-named class, since the runner renders by name", async () => {
    const result = await validateSceneSource("from manim import *\n\nclass MyScene(Scene):\n    def construct(self):\n        pass");
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/LessonScene/);
  });

  it("rejects two scene classes, which would leave the render ambiguous", async () => {
    const two =
      "from manim import *\n\nclass LessonScene(Scene):\n    def construct(self):\n        pass\n\nclass Other(Scene):\n    def construct(self):\n        pass";
    const result = await validateSceneSource(two);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/exactly one/);
  });
});

describe("renderCacheKey", () => {
  it("is stable for identical source and duration", () => {
    expect(renderCacheKey(BENIGN, 8000)).toBe(renderCacheKey(BENIGN, 8000));
  });

  it("changes with duration, since the same code renders a different clip", () => {
    expect(renderCacheKey(BENIGN, 8000)).not.toBe(renderCacheKey(BENIGN, 9000));
  });

  it("changes with source", () => {
    expect(renderCacheKey(BENIGN, 8000)).not.toBe(renderCacheKey(`${BENIGN}\n        self.wait(1)`, 8000));
  });
});

describe("renderScene — real renders", () => {
  it("renders a scene to a real video of the requested length", async () => {
    const health = await checkRenderHealth(true);
    if (!health.healthy) {
      // Not a silent pass: the venv genuinely isn't installed in this
      // environment, and the validator suite above still covered the gate.
      expect(health.problems.join(" ")).toMatch(/interpreter|manim/);
      return;
    }

    const result = await renderScene({ source: BENIGN, durationMs: 4000 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.buffer.length).toBeGreaterThan(1000);
    // Exact equality is not asserted: the model's own run_time arithmetic
    // decides this, and assembly conforms it to the audio afterwards (§7).
    expect(result.actualDurationMs).toBeGreaterThan(2000);
    expect(result.actualDurationMs).toBeLessThan(8000);
  }, 180_000);

  it("refuses hostile source before executing anything", async () => {
    const result = await renderScene({ source: `import os\n${scene("        os.system('id')")}`, durationMs: 4000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // "validate" specifically — reaching "render" would mean it ran.
    expect(result.stage).toBe("validate");
  }, 60_000);

  it("kills a scene that never terminates, rather than hanging the request", async () => {
    const health = await checkRenderHealth();
    if (!health.healthy) return;

    const spinner = scene("        n = 0\n        while True:\n            n = n + 1");
    const result = await renderScene({ source: spinner, durationMs: 4000 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("render");
  }, 180_000);
});
