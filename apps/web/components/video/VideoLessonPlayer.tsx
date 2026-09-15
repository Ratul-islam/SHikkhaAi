"use client";

import { useMemo, useRef, useState } from "react";
import { Player, type PlayerRef } from "@remotion/player";
import { PauseCircle, Send } from "lucide-react";
import { isAxiosError } from "axios";
import LessonComposition from "./LessonComposition";
import { api } from "../../lib/api";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import type { TimestampAskResponse, VideoLessonResponse, WordTiming } from "../../lib/types";

const FPS = 30;
const TAIL_BUFFER_MS = 800; // a little silence after the last word before the lesson ends

interface Sentence {
  text: string;
  startMs: number;
  endMs: number;
}

/** Groups the word-level manifest into sentences (splits after ., ?, ! tokens) so a paused timestamp maps to a whole spoken sentence, not just one word. */
function groupIntoSentences(timestamps: WordTiming[]): Sentence[] {
  const sentences: Sentence[] = [];
  let current: WordTiming[] = [];

  for (const word of timestamps) {
    current.push(word);
    if (/[.?!]$/.test(word.word)) {
      sentences.push({
        text: current.map((w) => w.word).join(" "),
        startMs: current[0]!.startMs,
        endMs: current[current.length - 1]!.endMs,
      });
      current = [];
    }
  }
  if (current.length > 0) {
    sentences.push({
      text: current.map((w) => w.word).join(" "),
      startMs: current[0]!.startMs,
      endMs: current[current.length - 1]!.endMs,
    });
  }
  return sentences;
}

function findSentenceAt(sentences: Sentence[], ms: number): Sentence | null {
  const enclosing = sentences.find((s) => ms >= s.startMs && ms <= s.endMs);
  if (enclosing) return enclosing;
  // Between sentences (a pause) — fall back to the most recently spoken one.
  const before = [...sentences].reverse().find((s) => s.startMs <= ms);
  return before ?? sentences[0] ?? null;
}

export default function VideoLessonPlayer({
  videoId,
  lesson,
  subject,
  chapter,
  reducedMotion,
}: {
  videoId: string;
  /** The built lesson, exactly as /video/build returned it. */
  lesson: VideoLessonResponse;
  /** Phase 2 §2.5 — passed through to /chat/timestamp-ask so it can retrieve grounding context; this player only exists inside a specific (subject, chapter) chat thread. */
  subject: string;
  chapter: number;
  /** Phase 3 — UserSettings.reducedMotion, forwarded to LessonComposition. */
  reducedMotion?: boolean;
}): JSX.Element {
  const playerRef = useRef<PlayerRef>(null);
  const timestampManifest = lesson.timestampManifest ?? [];
  const sentences = useMemo(() => groupIntoSentences(timestampManifest), [timestampManifest]);

  const [selectedSentence, setSelectedSentence] = useState<Sentence | null>(null);
  const [question, setQuestion] = useState("");
  const [explanation, setExplanation] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);

  // The lesson's own reported length is authoritative — it is the sum of the
  // scenes' measured audio durations. The old version derived this from the
  // last caption word plus the footage length, which is exactly the kind of
  // recomputation that let the player and the timeline disagree.
  const lessonMs = lesson.totalDurationMs || (timestampManifest.at(-1)?.endMs ?? 3000);
  const durationInFrames = Math.max(30, Math.round(((lessonMs + TAIL_BUFFER_MS) / 1000) * FPS));

  function handlePauseAndMark(): void {
    const player = playerRef.current;
    if (!player) return;
    player.pause();
    const currentMs = (player.getCurrentFrame() / FPS) * 1000;
    const sentence = findSentenceAt(sentences, currentMs);
    setSelectedSentence(sentence);
    setQuestion("");
    setExplanation(null);
    setAskError(null);
  }

  async function handleAsk(): Promise<void> {
    if (!selectedSentence || !question.trim()) return;
    setAsking(true);
    setAskError(null);
    try {
      const response = await api.post<TimestampAskResponse>("/chat/timestamp-ask", {
        videoId,
        timestampMs: Math.round(selectedSentence.startMs),
        spokenSentence: selectedSentence.text,
        userQuestion: question.trim(),
        subject,
        chapter,
      });
      setExplanation(response.data.explanation);
    } catch (err) {
      const msg = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setAskError(msg ?? "Couldn't get an explanation — try again.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-xl border border-outline-variant/30">
        <Player
          ref={playerRef}
          component={LessonComposition}
          inputProps={{
            title: lesson.title,
            timestamps: timestampManifest,
            reducedMotion,
            scenes: lesson.scenes,
            ...(lesson.lessonUrl ? { lessonUrl: lesson.lessonUrl } : {}),
            // Only a turn stored before the Manim pipeline carries this.
            ...(lesson.videoScript && lesson.audioUrl
              ? { legacy: { audioUrl: lesson.audioUrl, visualCues: lesson.videoScript.visualCues } }
              : {}),
          }}
          durationInFrames={durationInFrames}
          compositionWidth={960}
          compositionHeight={540}
          fps={FPS}
          controls
          style={{ width: "100%" }}
        />
      </div>

      <Button variant="secondary" size="sm" onClick={handlePauseAndMark} className="self-start">
        <PauseCircle className="size-4" />
        Pause &amp; ask about this part
      </Button>

      <Sheet open={selectedSentence !== null} onOpenChange={(open) => !open && setSelectedSentence(null)}>
        <SheetContent side="right" className="glass-panel-strong w-full sm:max-w-sm">
          <SheetHeader>
            <SheetTitle>Ask about this moment</SheetTitle>
            <SheetDescription>{selectedSentence?.text}</SheetDescription>
          </SheetHeader>

          <div className="flex flex-col gap-3 px-4">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="What don't you understand about this part?"
              rows={3}
              className="rounded-lg border border-input bg-card/70 px-3 py-2 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <Button onClick={handleAsk} disabled={asking || !question.trim()} className="self-start">
              <Send className="size-4" />
              {asking ? "Asking…" : "Ask"}
            </Button>

            {askError && <p className="text-sm text-destructive">{askError}</p>}
            {explanation && (
              <div className="glass-panel rounded-lg p-3 text-sm text-foreground/80">{explanation}</div>
            )}
          </div>

          <SheetFooter />
        </SheetContent>
      </Sheet>
    </div>
  );
}
