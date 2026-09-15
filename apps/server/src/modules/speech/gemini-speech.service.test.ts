import { describe, expect, it } from "vitest";
import { alignWords, pcmDurationMs, pcmToWav } from "./gemini-speech.service";

describe("pcmToWav", () => {
  it("prefixes a 44-byte RIFF/WAVE header a browser will accept", () => {
    const pcm = Buffer.alloc(1000);
    const wav = pcmToWav(pcm);

    expect(wav.length).toBe(1044);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length); // data chunk size
    expect(wav.readUInt32LE(4)).toBe(36 + pcm.length); // RIFF size
  });

  it("declares Gemini's documented format: 24kHz, 16-bit, mono", () => {
    const wav = pcmToWav(Buffer.alloc(8));
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24_000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.readUInt32LE(28)).toBe(24_000 * 2); // byte rate
  });
});

describe("pcmDurationMs", () => {
  it("computes duration exactly from byte count — no probing needed", () => {
    // 24000 samples/sec * 2 bytes = 48000 bytes per second.
    expect(pcmDurationMs(Buffer.alloc(48_000))).toBe(1000);
    expect(pcmDurationMs(Buffer.alloc(24_000))).toBe(500);
    expect(pcmDurationMs(Buffer.alloc(0))).toBe(0);
  });
});

describe("alignWords", () => {
  const BANGLA = "বল আর ত্বরণের সম্পর্ক দেখো। ভর বাড়লে ত্বরণ কমে। এটাই নিউটনের সূত্র।";

  it("spans the entire audio: starts at 0, ends exactly at the duration", () => {
    const t = alignWords(BANGLA, 10_000);
    expect(t[0]!.startMs).toBe(0);
    expect(t.at(-1)!.endMs).toBe(10_000);
  });

  it("is monotonic and contiguous — no overlaps, no gaps", () => {
    const t = alignWords(BANGLA, 10_000);
    for (let i = 0; i < t.length; i++) {
      expect(t[i]!.endMs).toBeGreaterThanOrEqual(t[i]!.startMs);
      if (i > 0) expect(t[i]!.startMs).toBe(t[i - 1]!.endMs);
    }
  });

  it("emits one entry per word", () => {
    expect(alignWords("এক দুই তিন", 3000)).toHaveLength(3);
  });

  it("gives a sentence-ending word more time than an identical mid-sentence word", () => {
    // Same word twice; only the second ends a sentence.
    const t = alignWords("চাপ চাপ। চাপ চাপ", 4000);
    const midSentence = t[0]!.endMs - t[0]!.startMs;
    const sentenceEnd = t[1]!.endMs - t[1]!.startMs;
    expect(sentenceEnd).toBeGreaterThan(midSentence);
  });

  it("gives longer words more time than shorter ones", () => {
    const t = alignWords("ক ত্বরণেরই", 2000);
    expect(t[1]!.endMs - t[1]!.startMs).toBeGreaterThan(t[0]!.endMs - t[0]!.startMs);
  });

  // The property timestamp-ask actually depends on: a paused millisecond must
  // land inside the sentence being spoken, which needs boundaries in roughly
  // the right place, not per-word precision.
  it("places a sentence boundary near where proportional reading would put it", () => {
    // Two sentences of equal length -> the split should sit near the midpoint.
    const t = alignWords("একদম একদম একদম একদম। একদম একদম একদম একদম।", 10_000);
    const firstSentenceEnd = t[3]!.endMs;
    expect(firstSentenceEnd).toBeGreaterThan(4_000);
    expect(firstSentenceEnd).toBeLessThan(6_000);
  });

  it("returns nothing for empty text or zero-length audio rather than dividing by zero", () => {
    expect(alignWords("", 5000)).toEqual([]);
    expect(alignWords("   ", 5000)).toEqual([]);
    expect(alignWords("কিছু", 0)).toEqual([]);
  });

  it("handles a single word", () => {
    const t = alignWords("ডায়োড", 2500);
    expect(t).toHaveLength(1);
    expect(t[0]).toEqual({ word: "ডায়োড", startMs: 0, endMs: 2500 });
  });
});
