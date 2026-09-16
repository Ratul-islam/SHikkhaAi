import type { FastifyInstance } from "fastify";
import { chatClient, CHAT_MODEL } from "../../lib/openai";
import { env } from "../../config/env";
import type { DirectedScene, DirectedScript } from "./director.schema";
import { validateSceneSource } from "./manim/render.service";

/**
 * Stage [3a] — turns one scene's direction into Manim source (PLAN.md §5).
 *
 * Per PLAN.md §3.2 this runs for EVERY scene: there is no renderer choice and
 * no "this one's hard, do it in SVG" escape hatch, because the cheap path is
 * the good path and offering an alternative is how a codebase drifts back onto
 * the expensive one. The SVG fallback exists for a scene whose render FAILED,
 * not for a scene the model would rather not draw.
 *
 * Which makes this prompt the product. The validator proves a scene ran; only
 * this prompt decides whether it taught anything.
 */

const MANIM_SYSTEM_PROMPT = `You write Manim scenes for a Bangladeshi student's lesson. You are given one scene's direction and you return ONE Python module that draws it. Return code only — no prose, no markdown fence, no explanation.

THE EXACT SHAPE, always:

from manim import *

class LessonScene(Scene):
    def construct(self):
        ...

\`SCENE_DURATION\` is ALREADY DEFINED for you as a float — the number of seconds this scene is on screen, fixed by the narration recorded for it. Do not define it, do not import it. Express every \`run_time\` and \`self.wait\` as a fraction of it so the animation fills the scene exactly:

        self.play(Write(title), run_time=SCENE_DURATION * 0.2)
        self.play(arrow.animate.shift(RIGHT * 2), run_time=SCENE_DURATION * 0.5)
        self.wait(SCENE_DURATION * 0.3)

Your fractions should sum to about 1.0.

BANGLA AND MATHS — the single most important rule here:
- Bangla text ONLY through \`Text("...", font="Noto Sans Bengali")\`. That is the Pango path and it renders Bengali correctly.
- Equations, numerals and symbols through \`MathTex(r"...")\`. That is the LaTeX path.
- Keep LaTeX SIMPLE — a fragment that does not compile takes the whole scene down with an unhelpful error. Plain symbols, fractions, subscripts, superscripts, \`\\vec{}\`, \`\\frac{}{}\`, \`\\text{}\`. No \`align\`/\`array\` environments, no \`\\special\`, no custom macros, no packages.
- **NEVER put a Bangla character inside MathTex or Tex.** LaTeX cannot typeset Bengali — it does not render badly, it fails. A label like "বেগ = 5 m/s" must be a \`Text\`, or split into a \`Text("বেগ")\` next to a \`MathTex(r"= 5\\,\\text{m/s}")\`.
- Latin text and numbers are fine in either.

ANIMATE THE MECHANISM, not decoration. Show the thing working: the ball accelerating, the current going round the loop, the piston pushing, the mercury column dropping, the graph tracing itself. If your scene would look the same at the start and the end, it is a still picture with a delay in it and it teaches nothing. Numbers that update as things move are often the clearest part of all — use \`always_redraw\` or a \`ValueTracker\` for a live readout.

LAYOUT — this is where these scenes fail, and the failures are not subtle: shapes drawn off the edge, labels sitting on top of the drawing, a second picture built over a live first one. Treat everything below as a hard constraint.

THE THREE BANDS. The frame is 14.2 units wide by 8 tall, centred on the origin. Divide it, and never let one band's content cross into another:
- TITLE BAND, y above +2.8 — the title, nothing else. \`title.to_edge(UP)\`.
- THE STAGE, x from -6.0 to 6.0, y from -2.4 to +2.4 — the drawing. Every shape, arrow, graph and attached label lives here.
- READOUT BAND, y below -2.8 — one live value or unit note. \`.to_edge(DOWN)\` or \`.to_corner(DL)\`.
Nothing is ever placed outside x from -6.5 to 6.5, y from -3.5 to 3.5. A shape drawn past the edge is simply not there for the student.

FIT THE PICTURE, EXPLICITLY. Never assume what you built fits — group it and clamp it before you animate it:

        picture = VGroup(block, arrow, ground).arrange(RIGHT, buff=0.6)
        if picture.width > 11.5:
            picture.scale_to_fit_width(11.5)
        if picture.height > 4.6:
            picture.scale_to_fit_height(4.6)
        picture.move_to(ORIGIN)

\`arrange\` is how you lay several things out without computing coordinates by hand: \`VGroup(a, b, c).arrange(DOWN, buff=0.4)\`. Use it for anything that is a row or a column.

TEXT DOES NOT WRAP. \`Text\` draws exactly the string you give it, however far past the edge that runs.
- Break lines yourself with a newline escape inside the string. Keep one line under about 28 Bangla characters.
- Then clamp it anyway: \`if label.width > 6.0: label.scale_to_fit_width(6.0)\`.
- A \`MathTex\` over about 24 characters overflows too. Split it into two \`MathTex\` objects arranged DOWN rather than one long line.
- Bangla body text at \`font_size=28\` to \`36\`; titles \`40\`. Below 28 is unreadable on a phone, so shorten the WORDS, never the type.

NOTHING OVERLAPS. Every object after the first is positioned RELATIVE to something already placed — \`.next_to(obj, UP, buff=0.3)\`, \`.to_edge()\`, \`.to_corner()\`, \`.move_to()\`. Two mobjects created and added without positioning both sit at the origin, on top of each other.
- A label belongs to its object, not to the frame: \`label.next_to(block, DOWN, buff=0.25)\`.
- Minimum \`buff\` of 0.25 between anything and anything. An arrow that ends where a label begins has collided.
- Attach an annotation with \`SurroundingRectangle\` or \`Brace\` rather than floating it nearby and hoping.

ONE PICTURE AT A TIME. If the scene moves on to a second distinct picture, the first one LEAVES first — \`self.play(FadeOut(picture), run_time=SCENE_DURATION * 0.1)\` — or better, \`ReplacementTransform\` the old into the new so the student sees the connection. Building a second cluster over a live first one is exactly what turns a scene into a mush of overlapping shapes.

BUDGET THE STAGE. At most 7 mobjects visible at once, at most 2 Bangla labels besides the title, at most 1 live readout. Every extra object is another chance for a collision, and a busy frame teaches worse than a clear one.

A REDRAWN OBJECT MUST PLACE ITSELF. \`always_redraw\` rebuilds its mobject from scratch every frame, which throws away any \`.next_to()\` or \`.scale_to_fit_width()\` applied OUTSIDE the lambda — the rebuilt one snaps back to the origin, on top of the drawing. Put the placement inside the lambda, and fix the decimals so the text does not change width as it counts:

        readout = always_redraw(lambda: Text(f"বেগ: {speed.get_value():.1f} m/s", font="Noto Sans Bengali", font_size=28).to_edge(DOWN))

AXES ARE BIGGER THAN YOU THINK. Keep \`x_length\` at most 7.5 and \`y_length\` at most 4.2, place the \`Axes\` with \`.move_to(ORIGIN)\`, and remember the axis labels stick out past that box — leave room for them.

THE BACKGROUND IS DARK. Use bright, high-contrast colours.
- COLOUR CONSTANTS — these are the ONLY ones that exist. Anything else is a NameError that kills the scene:
  WHITE BLACK GREY GRAY (plus _A.._E and DARK_/LIGHT_/DARKER_/LIGHTER_ variants)
  RED BLUE GREEN YELLOW GOLD ORANGE PINK PURPLE TEAL MAROON (each with _A.._E variants, e.g. BLUE_D, RED_E)
  DARK_BLUE DARK_BROWN LIGHT_BROWN GREY_BROWN LIGHT_PINK PURE_RED PURE_GREEN PURE_BLUE
  There is no BROWN, no BROWN_D, no SILVER, no CYAN, no LIME. For anything else use a hex string: \`color="#8B4513"\`.

CARRY-OVER — when the direction says something carries over from the previous scene, DRAW IT IN THE SAME PLACE, the same size and the same colour, and then transform it. That continuity is what makes the lesson feel like one idea developing rather than three unrelated pictures. \`Transform\` and \`ReplacementTransform\` are how you show one thing becoming another.

WHAT YOU MAY USE: \`from manim import *\`, plus \`numpy\`, \`math\`, \`random\`, \`itertools\` and \`functools\` if you need them. Nothing else is importable. No file access, no network, no \`os\`, no \`subprocess\`, no \`open\`, no \`exec\`/\`eval\`, no \`getattr\`, and no attribute or name beginning with a double underscore. Code using any of those is rejected before it runs.

VALUES THAT CHANGE — use a \`ValueTracker\`, never an attribute on \`self\`:

        speed = ValueTracker(0)
        arrow = always_redraw(lambda: Arrow(ORIGIN, RIGHT * speed.get_value(), color=YELLOW, buff=0))
        readout = always_redraw(lambda: Text(f"বেগ: {speed.get_value():.1f}", font="Noto Sans Bengali", font_size=28).to_corner(UL))
        self.add(arrow, readout)
        self.play(speed.animate.set_value(6), run_time=SCENE_DURATION * 0.5)

\`always_redraw\` calls your lambda IMMEDIATELY, so everything it references must already exist on the line above it. Assigning a helper to \`self\` and using it inside the lambda crashes with AttributeError — that exact mistake has been made here before.

NO FILES. \`ImageMobject\`, \`SVGMobject\` and anything else that loads a picture from disk are rejected: there are no image files to load. Draw everything from primitives — \`Circle\`, \`Rectangle\`, \`Polygon\`, \`Line\`, \`Arrow\`, \`Arc\`, \`VGroup\`. A car is a rectangle and two circles; that reads perfectly well at lesson scale.

MANIM 0.21 — this is a RECENT version and several older names you may know were REMOVED. Using one is a hard failure:
| you might write | it is now |
|---|---|
| \`ShowCreation(x)\` | \`Create(x)\` |
| \`axes.get_graph(f, ...)\` | \`axes.plot(f, ...)\` |
| \`axes.get_line_graph(...)\` | \`axes.plot_line_graph(...)\` |
| \`TextMobject\` / \`TexMobject\` | \`Text\` / \`MathTex\` |
| \`FadeInFrom(x, UP)\` | \`FadeIn(x, shift=UP)\` |
| \`GraphScene\` | a plain \`Scene\` holding an \`Axes\` |

A GRAPH looks like this, and \`plot\` is the only correct name:

        axes = Axes(x_range=[0, 5, 1], y_range=[0, 25, 5], x_length=7, y_length=4)
        curve = axes.plot(lambda t: t * t, x_range=[0, 5], color=YELLOW)
        labels = axes.get_axis_labels(x_label=MathTex(r"t"), y_label=MathTex(r"v"))
        self.play(Create(axes), Write(labels), run_time=SCENE_DURATION * 0.3)
        self.play(Create(curve), run_time=SCENE_DURATION * 0.5)

SAFE TO USE: \`Create\`, \`Uncreate\`, \`FadeIn\`/\`FadeOut\`, \`Write\`, \`Transform\`, \`ReplacementTransform\`, \`GrowArrow\`, \`GrowFromCenter\`, \`Indicate\`, \`DrawBorderThenFill\`, \`.animate\`, \`ValueTracker\`, \`always_redraw\`, \`Axes\`, \`NumberPlane\`, \`NumberLine\`, \`Arrow\`, \`Line\`, \`DashedLine\`, \`Dot\`, \`Circle\`, \`Arc\`, \`Square\`, \`Rectangle\`, \`Polygon\`, \`VGroup\`, \`SurroundingRectangle\`, \`Brace\`. Rate functions live on \`rate_functions\` (\`rate_functions.ease_in_quad\`, \`smooth\`, \`linear\`).`;

function buildSceneUserMessage(params: {
  script: DirectedScript;
  scene: DirectedScene;
  index: number;
  durationMs: number;
  durationIsEstimate?: boolean;
}): string {
  const { script, scene, index, durationMs, durationIsEstimate } = params;

  return [
    `LESSON: ${script.title}`,
    script.approach ? `TEACHING ARC: ${script.approach}` : null,
    "",
    `SCENE ${index + 1} of ${script.scenes.length} — role: ${scene.role}`,
    durationIsEstimate
      ? `SCENE_DURATION will be about ${(durationMs / 1000).toFixed(0)} seconds — the exact value is fixed when the narration is recorded, so time everything from SCENE_DURATION, never from this number.`
      : `SCENE_DURATION is ${(durationMs / 1000).toFixed(2)} seconds.`,
    "",
    `WHAT IS SPOKEN OVER THIS SCENE (Bangla, for your timing — do NOT put this text on screen):`,
    scene.narration,
    "",
    `DRAW THIS:`,
    scene.visualBrief,
    scene.carryOver ? `\nCARRIED OVER FROM THE PREVIOUS SCENE: ${scene.carryOver}` : null,
    scene.labels.length > 0 ? `\nBANGLA LABELS that must appear (use Text with the Bengali font): ${scene.labels.join(" · ")}` : null,
    scene.mathTex.length > 0 ? `\nLATEX that must appear (use MathTex): ${scene.mathTex.join("   ")}` : null,
    scene.beats.length > 0
      ? `\nMOMENTS the camera cares about, as fractions of the scene: ${scene.beats
          .map((b) => `${Math.round(b.at * 100)}% "${b.highlightText}"`)
          .join(", ")}`
      : null,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Models fence code even when told not to. Same problem `extractJsonPayload`
 * solves for JSON, and the same fix — strip a fence that wraps the WHOLE
 * reply, anchored to the ends so a fence *inside* the code (there shouldn't be
 * one, but a docstring could contain anything) is left alone.
 */
export function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:python|py)?\s*\n?([\s\S]*?)```\s*$/i);
  return (fenced?.[1] ?? trimmed).trim();
}

export interface SceneCodeResult {
  source: string | null;
  /** Every attempt's rejection, for logging — an empty list means it passed first try. */
  attempts: string[];
}

/**
 * Generates validated Manim source for one scene.
 *
 * Retries on a validator rejection with the errors fed back (PLAN.md §8). The
 * retry is worth its ~$0.001: most first-attempt failures are mechanical — a
 * kwarg that doesn't exist in 0.21, Bangla that wandered into a MathTex — and
 * the alternative is a visibly worse fallback scene. Validation happens HERE,
 * before the render is queued, so a doomed scene never occupies a render slot.
 */
export async function generateSceneCode(
  app: FastifyInstance,
  params: {
    script: DirectedScript;
    scene: DirectedScene;
    index: number;
    durationMs: number;
    /**
     * True when `durationMs` is estimated from the narration's length rather
     * than measured from its audio — the first draft is written WHILE the
     * narration is still being synthesized (see lesson-build.service).
     */
    durationIsEstimate?: boolean;
    /**
     * Failures from earlier rounds — a validator rejection OR a render
     * traceback. Both are fed back the same way, which is the point: a scene
     * that parses cleanly and then crashes at run time is the commoner failure
     * of the two, and a retry that only saw validation errors could never fix it.
     */
    priorFailures?: string[];
  },
): Promise<SceneCodeResult> {
  const userMessage = buildSceneUserMessage(params);
  const attempts: string[] = [...(params.priorFailures ?? [])];

  for (let attempt = 0; attempt <= env.MANIM_MAX_RETRIES; attempt++) {
    const messages: { role: "system" | "user"; content: string }[] = [
      { role: "system", content: MANIM_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ];

    if (attempts.length > 0) {
      messages.push({
        role: "user",
        content: `Your previous attempt FAILED:\n\n${attempts[attempts.length - 1]}\n\nFix exactly that and return the corrected module. Code only.`,
      });
    }

    let raw: string;
    try {
      const completion = await chatClient.chat.completions.create({ model: CHAT_MODEL, messages });
      raw = completion.choices[0]?.message?.content ?? "";
    } catch (err) {
      app.log.error({ err, sceneId: params.scene.id }, "Scene code generation call failed");
      attempts.push("model call failed");
      continue;
    }

    const source = stripCodeFence(raw);
    if (!source) {
      attempts.push("model returned nothing");
      continue;
    }

    const validation = await validateSceneSource(source);
    if (validation.ok) return { source, attempts };

    attempts.push(validation.errors.join("\n"));
    app.log.warn(
      { sceneId: params.scene.id, attempt, errors: validation.errors.slice(0, 3) },
      "Generated scene rejected by the AST gate",
    );
  }

  return { source: null, attempts };
}
