import type { VisualCue } from "../chat/orchestrator";
import type { WordTiming } from "../speech/edge-speech.service";

/**
 * Closes PLAN.md's [GAP-2]: the Orchestrator's `timeMs` per cue is a guess
 * made *before* narration exists (PROMPT.md §5 already tells the model so),
 * against text length rather than real speech timing. This reconciles each
 * cue's `highlightText` against the real edge-tts word timeline so a cue
 * lands on the moment its words are actually spoken, not a linear estimate.
 */

const MIN_GAP_MS = 200; // cues can't reorder or collide — see monotonicity note below

function normalize(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** First content word of the cue's highlightText — matching on one anchor word is more robust against paraphrasing than trying to match a whole phrase verbatim. */
function firstToken(highlightText: string): string | null {
  const tokens = highlightText
    .split(/\s+/)
    .map(normalize)
    .filter((t) => t.length > 0);
  return tokens[0] ?? null;
}

/**
 * For one cue, finds the word in the timeline whose normalized text matches
 * (or contains/`is contained by`, to tolerate stemming differences) the
 * cue's anchor word, picking whichever match is closest to the model's own
 * original `timeMs` guess when several occurrences exist (ties: earliest
 * wins, since `Array.prototype.find`-style scanning naturally prefers it).
 */
function findBestMatch(anchor: string, timeMs: number, timestamps: WordTiming[]): WordTiming | null {
  let best: WordTiming | null = null;
  let bestDistance = Infinity;

  for (const word of timestamps) {
    const normalized = normalize(word.word);
    if (!normalized) continue;
    const matches = normalized === anchor || normalized.startsWith(anchor) || anchor.startsWith(normalized);
    if (!matches) continue;

    const distance = Math.abs(word.startMs - timeMs);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = word;
    }
  }

  return best;
}

/**
 * Aligns every cue's `timeMs` to the real audio, in place order. Cues are
 * assumed sorted by the model's own `timeMs` (PROMPT.md's contract) —
 * processed in that order so monotonicity can be enforced by construction:
 * each aligned cue is clamped to at least `MIN_GAP_MS` after the previous
 * one, so a bad match can never make a later cue appear to fire earlier
 * than an one before it.
 */
export function alignCues(cues: VisualCue[], timestamps: WordTiming[]): VisualCue[] {
  if (timestamps.length === 0) return cues;

  const audioEndMs = timestamps[timestamps.length - 1]!.endMs;
  let floor = 0;

  return cues.map((cue) => {
    const anchor = firstToken(cue.highlightText);
    const match = anchor ? findBestMatch(anchor, cue.timeMs, timestamps) : null;

    // No match found (paraphrased narration, or the cue references
    // something never actually spoken) — fall back to the model's own
    // guess, clamped to the real audio's duration rather than trusting an
    // estimate that could run past the end of the narration.
    const candidateMs = match ? match.startMs : Math.min(cue.timeMs, audioEndMs);

    const alignedMs = Math.max(candidateMs, floor);
    floor = alignedMs + MIN_GAP_MS;

    return { ...cue, timeMs: alignedMs };
  });
}
