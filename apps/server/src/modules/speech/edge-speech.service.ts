import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { EdgeTTS } from "@andresaya/edge-tts";

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface NarrationResult {
  audioUrl: string;
  timestamps: WordTiming[];
}

const BANGLA_VOICE = "bn-BD-NabanitaNeural";
const ENGLISH_VOICE = "en-US-AnaNeural";

// 100-nanosecond ticks — the standard Azure/Edge-TTS protocol unit for
// WordBoundary offset/duration. Confirmed by reading @andresaya/edge-tts's
// own source: it passes these values through from the raw websocket
// metadata with no conversion, so we're the ones who divide by 10,000.
const TICKS_PER_MS = 10_000;

export const UPLOADS_DIR = path.join(__dirname, "../../../uploads");

function pickVoice(accentLocale?: string): string {
  return accentLocale?.toLowerCase().startsWith("bn") ? BANGLA_VOICE : ENGLISH_VOICE;
}

/** "bn-BD-NabanitaNeural" -> "bn-BD" — Azure/Edge voice names are always "<locale>-<name>Neural". */
function localeFromVoice(voice: string): string {
  const [lang, region] = voice.split("-");
  return lang && region ? `${lang}-${region}` : "en-US";
}

/**
 * @andresaya/edge-tts@1.8.0's own `getSSML()` hardcodes `xml:lang="en-US"` on
 * the `<speak>` tag no matter which voice is requested (confirmed by reading
 * its source — not exposed as an option). That mismatch matters: Azure's
 * neural TTS uses `xml:lang` to pick text-normalization rules (numbers,
 * punctuation, abbreviations) independently of the voice's own phonemes, so
 * Bangla narration synthesized with the Bangla voice was still having its
 * text normalized as if it were English — a real, audible cause of "this
 * doesn't sound like proper Bangla," especially on any digits or symbols in
 * the script. `synthesize()` calls `this.getSSML(...)`, so overriding the
 * instance method (own property shadows the prototype's) patches this
 * without forking the package.
 */
function patchSsmlLocale(tts: EdgeTTS): void {
  const original = (tts as unknown as { getSSML: (content: string, voice: string, options?: unknown) => string }).getSSML.bind(tts);
  (tts as unknown as { getSSML: (content: string, voice: string, options?: unknown) => string }).getSSML = (
    content: string,
    voice: string,
    options?: unknown,
  ) => original(content, voice, options).replace('xml:lang="en-US"', `xml:lang="${localeFromVoice(voice)}"`);
}

/**
 * Synthesizes narration via Microsoft Edge's free TTS service (no API key,
 * no per-use cost) and returns a fetchable audio URL plus word-level
 * timestamps for karaoke-style captions. Saves both the MP3 and a
 * timestamp-manifest JSON under apps/server/uploads/.
 */
export async function synthesizeNarration(text: string, accentLocale?: string): Promise<NarrationResult> {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });

  const tts = new EdgeTTS();
  patchSsmlLocale(tts);
  const voice = pickVoice(accentLocale);
  await tts.synthesize(text, voice);

  const id = randomUUID();
  const savedPath = await tts.toFile(path.join(UPLOADS_DIR, id)); // appends ".mp3" itself

  const boundaries = tts.getWordBoundaries();
  const timestamps: WordTiming[] = boundaries.map((b) => ({
    word: b.text,
    startMs: Math.round(b.offset / TICKS_PER_MS),
    endMs: Math.round((b.offset + b.duration) / TICKS_PER_MS),
  }));

  await fs.writeFile(path.join(UPLOADS_DIR, `${id}.json`), JSON.stringify(timestamps));

  return {
    audioUrl: `/uploads/${path.basename(savedPath)}`,
    timestamps,
  };
}
