/**
 * Preparation shared by both sandboxed-HTML surfaces: chat's interactive
 * widgets (`VisualSandbox`) and video scene diagrams (`LessonComposition`).
 *
 * ── Why `hoistScripts` exists ─────────────────────────────────────────────
 * Models overwhelmingly write their diagram as one `<svg>` with the `<script>`
 * nested *inside* it. That placement silently breaks the script: inside
 * `<svg>` the HTML parser is in foreign-content mode, and template literals in
 * there are not evaluated. Measured on identical JavaScript, only moving the
 * `<script>` out of the `<svg>`:
 *
 *   script INSIDE  <svg>  ->  d = "M320,${arrowY} L320,${arrowY + arrowLength}"   (2 console errors)
 *   script OUTSIDE <svg>  ->  d = "M320,92.05 L320,165.55 M310,155.55 ..."        (0 errors)
 *
 * Every one of five sampled generated scenes had the script inside the svg, so
 * this is the common case, not an edge case. Prompting alone can't be trusted
 * with something this silent — and prompting can't repair the videos already
 * stored in history — so the markup is repaired here at render time.
 */

export interface HoistedHtml {
  /** The original markup with every `<script>` block removed. */
  markup: string;
  /** Those scripts, in source order, to be emitted after the markup so they run with it already in the DOM. */
  scripts: string;
}

const SCRIPT_BLOCK_PATTERN = /<script\b[^>]*>[\s\S]*?<\/script>/gi;

export function hoistScripts(html: string): HoistedHtml {
  const scripts = html.match(SCRIPT_BLOCK_PATTERN) ?? [];
  return {
    markup: html.replace(SCRIPT_BLOCK_PATTERN, ""),
    scripts: scripts.join("\n"),
  };
}

/**
 * Assembles a sandbox body: the drawing first, then its scripts, so the
 * scripts are outside any `<svg>` (see above) and still run with the markup
 * already parsed into the DOM — `getElementById` in a hoisted script keeps
 * working exactly as the author intended.
 */
export function buildSandboxBody(html: string): string {
  const { markup, scripts } = hoistScripts(html);
  return `${markup}\n${scripts}`;
}
