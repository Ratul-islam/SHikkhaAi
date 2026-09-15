"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Send, ImageOff, Loader2, BookOpenCheck, Menu, PanelRightOpen, PanelRightClose } from "lucide-react";
import { api } from "../../lib/api";
import {
  GENERAL_CHAPTER,
  GENERAL_SUBJECT,
  conversationHref,
  isGeneralConversation,
  nextConversationSlot,
} from "../../lib/chat";
import { streamChat, type ChatStage } from "../../lib/streamChat";
import ChatMessage, {
  buildActionPills,
  buildTutorTools,
  extractVisualHtml,
  type ChatMessageData,
} from "../../components/ChatMessage";
import ThinkingIndicator from "../../components/chat/ThinkingIndicator";
import ChatEmptyState from "../../components/chat/ChatEmptyState";
import ChatSidebar from "../../components/chat/ChatSidebar";
import ChatTopicPicker, { type ChatTopicTarget } from "../../components/chat/ChatTopicPicker";
import VisualSandbox, { type WidgetEvent } from "../../components/VisualSandbox";
import VideoLessonPlayer from "../../components/video/VideoLessonPlayer";
import TutorModeBadge from "../../components/TutorModeBadge";
import MasteryCheckPanel from "../../components/mastery/MasteryCheckPanel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import type {
  ChatChapterOption,
  ChatMessageRecord,
  ChatTopicsResponse,
  ChatResponse,
  ConversationSummary,
  LessonSessionStatus,
  ProfileSnapshot,
  ProfileView,
  StartLessonResponse,
  SubmitMasteryResponse,
  VideoLessonResponse,
  VideoBrief,
  VideoScript,
} from "../../lib/types";

interface LessonState {
  outlineLength: number;
  currentStep: number;
  status: LessonSessionStatus;
}

/** What a "watch this" carries: a brief for a current turn, a stored script for an old one. */
type WatchSource = { videoBrief: VideoBrief } | { videoScript: VideoScript };

interface VideoLessonState {
  status: "loading" | "ready" | "error";
  data?: VideoLessonResponse;
}

/** Typewriter reveal speed — tuned so a full explanation (500-1000 chars) finishes in a few seconds, not instantly and not annoyingly slow. */
const REVEAL_MS_PER_CHAR = 9;
const REVEAL_MAX_MS = 2800;
const REVEAL_TICK_MS = 24;

/** Placeholder for the composer once a thread has messages — kept as a named constant rather than inlined, since Bangla string literals inside JSX attributes have proven unreliable to patch in place with this toolchain's exact-match editor. */
const BOTTOM_COMPOSER_PLACEHOLDER = "তোমার প্রশ্নটা লেখো…";

/**
 * How long to wait for a cold lesson build.
 *
 * Must not be shorter than the server's own build deadline, and it was: builds
 * measured 100-210s (the spread is the TTS provider, which returns the same
 * chunk in anywhere from 6s to over 90s), while this gave up at exactly 180s.
 * A lesson that finished at 195s was built, paid for, shelved in the library —
 * and the student was shown a failure. That is the last of "the video never
 * loads", and it was a client-side ceiling, not a server bug.
 *
 * 6 minutes matches BUILD_DEADLINE_MS in lesson-build.service.ts: past that the
 * server has given up too, so there is genuinely nothing left to wait for.
 */
const VIDEO_POLL_INTERVAL_MS = 10_000;
const VIDEO_POLL_ATTEMPTS = 36; // 6 minutes, matching the server's build deadline

function findPrecedingUserQuestion(messages: ChatMessageData[], assistantIndex: number): string | null {
  for (let i = assistantIndex - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "user") return msg.content;
  }
  return null;
}

function ChatPageInner(): JSX.Element {
  const router = useRouter();
  const searchParams = useSearchParams();
  const subject = searchParams.get("subject") ?? GENERAL_SUBJECT;
  const chapter = Number(searchParams.get("chapter") ?? String(GENERAL_CHAPTER));
  const nodeId = searchParams.get("nodeId");
  const guided = searchParams.get("guided") === "1";
  /** The topic this conversation is narrowed to, or null for the whole chapter. Validated server-side against the student's own grade and this chapter. */
  const topicId = searchParams.get("topic");
  // No slot in the URL means a DRAFT — a blank conversation that doesn't exist
  // until its first message claims the next free slot (see sendMessage). That
  // is what makes bare /chat a start page instead of reopening an old thread.
  // Guided lessons are the exception: lesson.service.ts persists the kickoff
  // turn to slot 1, so a guided link must read that same thread.
  const slotParam = searchParams.get("conversationSlot");
  const conversationSlot: number | null = slotParam ? Number(slotParam) : guided ? 1 : null;
  const isDraft = conversationSlot === null;
  const isGeneral = isGeneralConversation(subject);

  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [videoLessons, setVideoLessons] = useState<Record<string, VideoLessonState>>({});
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [stage, setStage] = useState<ChatStage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completeStatus, setCompleteStatus] = useState<string | null>(null);
  const [profileSnapshot, setProfileSnapshot] = useState<ProfileSnapshot | null>(null);
  const [lesson, setLesson] = useState<LessonState | null>(null);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(true);
  /** Every chapter (with topics) the student can ask about — feeds the picker and titles the header. */
  const [chapterOptions, setChapterOptions] = useState<ChatChapterOption[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [visualOpen, setVisualOpen] = useState(false);
  /** Set by "বড় করে দেখো" on a specific message, so the drawer can show an older turn's widget instead of always the latest. Cleared whenever a new turn lands. */
  const [pinnedVisual, setPinnedVisual] = useState<string | null>(null);
  /** Message whose video the drawer should show — set by "ভিডিওটা দেখো" on any past turn. Null means "the latest turn's". */
  const [pinnedVideoId, setPinnedVideoId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const revealTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against React 18 Strict Mode's double-invoked effects firing two
  // concurrent lesson-start calls (and, worse, two model calls) on one mount.
  const lessonStartedRef = useRef(false);
  /** The thread a draft just claimed on its first send — lets the history effect skip the URL change it caused instead of wiping the in-flight turn. */
  const adoptedThreadRef = useRef<string | null>(null);
  /** Bumped whenever a different thread is put on screen; async work captures it and drops its result if it changed. */
  const threadEpochRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Set by "নতুন কথোপকথন" so the start page's composer takes focus once it's actually on screen. */
  const focusComposerRef = useRef(false);

  const loadConversations = useCallback(() => {
    api
      .get<{ conversations: ConversationSummary[] }>("/chat/conversations")
      .then((res) => setConversations(res.data.conversations))
      .finally(() => setConversationsLoading(false));
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    api
      .get<ChatTopicsResponse>("/chat/topics")
      .then((res) => setChapterOptions(res.data.chapters))
      .catch(() => setChapterOptions([]));
  }, []);

  // Phase 3 — fetched once per page visit, not per video build: a student's
  // reducedMotion preference doesn't change mid-session, so there's no need
  // to re-fetch it for every VIDEO turn.
  useEffect(() => {
    api.get<ProfileView>("/profile/me").then((res) => setReducedMotion(res.data.settings.reducedMotion)).catch(() => {});
  }, []);

  // Hydrates the thread from server-side history on mount (Phase 1.5) —
  // without this, a refresh (or a resumed guided lesson) would show an empty
  // thread even though the server already has every prior turn.
  useEffect(() => {
    const threadKey = `${subject}::${chapter}::${conversationSlot}`;
    if (adoptedThreadRef.current === threadKey) {
      adoptedThreadRef.current = null;
      return;
    }
    adoptedThreadRef.current = null;
    // A new thread on screen: anything still in flight for the previous one
    // (its history fetch, a streaming reply, a reveal) must not write here.
    const epoch = ++threadEpochRef.current;
    if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    setMessages([]);
    setSending(false);
    setStage(null);
    setError(null);
    setHistoryLoaded(false);
    if (conversationSlot === null) {
      setHistoryLoaded(true); // a draft has no history to load
      return;
    }
    api
      .get<{ messages: ChatMessageRecord[] }>("/chat/history", { params: { subject, chapter, conversationSlot } })
      .then((res) => {
        if (threadEpochRef.current !== epoch) return;
        setMessages(
          res.data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            responseType: m.responseType ?? undefined,
            reasoning: m.reasoning ?? undefined,
            visualHtml: m.visualHtml ?? undefined,
            suggestions: m.suggestions,
            // Both shapes are carried. Dropping what a past VIDEO turn needs
            // to rebuild from is why history once showed no videos at all: a
            // brief for turns made since the Manim pipeline, the legacy script
            // for older ones.
            videoBrief: m.videoBrief ?? undefined,
            videoScript: m.videoScript ?? undefined,
          })),
        );
      })
      .catch(() => {
        /* best-effort — an empty thread is a safe fallback */
      })
      .finally(() => {
        if (threadEpochRef.current === epoch) setHistoryLoaded(true);
      });
  }, [subject, chapter, conversationSlot]);

  // Kicks off (or resumes) a guided lesson once history has loaded, only
  // when the roadmap explicitly linked here with ?guided=1 — a plain "Ask a
  // question" visit never auto-starts one, per the product decision that
  // the guided walk is opt-in, not forced.
  useEffect(() => {
    if (!guided || !nodeId || !historyLoaded || lessonStartedRef.current) return;
    lessonStartedRef.current = true;

    api
      .post<StartLessonResponse>(`/lessons/${nodeId}/start`)
      .then((res) => {
        setLesson({ outlineLength: res.data.outline.length, currentStep: res.data.currentStep, status: res.data.status });
        if (res.data.turn) {
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              role: "assistant",
              content: res.data.turn!.content,
              responseType: res.data.turn!.responseType,
              reasoning: res.data.turn!.reasoning,
              visualHtml: res.data.turn!.visualHtml,
              suggestions: res.data.turn!.suggestions,
              videoBrief: res.data.turn!.videoBrief,
            },
          ]);
        }
      })
      .catch((err) => {
        setError(isErrorMessage(err) ?? "গাইডেড লেসন শুরু করা যায়নি।");
      });
  }, [guided, nodeId, historyLoaded]);

  useEffect(() => {
    if (focusComposerRef.current && historyLoaded && messages.length === 0) {
      focusComposerRef.current = false;
      composerRef.current?.focus();
    }
  }, [historyLoaded, messages.length]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, sending]);

  // Stop any in-flight reveal timer on unmount. A thread switch is handled in
  // the history effect above — keying this cleanup on the slot too would kill
  // the reveal when a draft claims its slot mid-turn.
  useEffect(() => {
    return () => {
      if (revealTimerRef.current) clearInterval(revealTimerRef.current);
    };
  }, []);

  const latestAssistant = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant") ?? null,
    [messages],
  );
  // A replayed past turn wins over the latest one; otherwise the newest video
  // shows, which is what a fresh VIDEO answer should do.
  const activeVideoId = pinnedVideoId ?? latestAssistant?.id;
  const latestVideoState = activeVideoId ? videoLessons[activeVideoId] : undefined;
  // The most recent turn that actually HAS a visual — not merely the most
  // recent turn. Following up on a diagram ("why is that right?") produces a
  // TEXT answer, and keying off the latest turn alone made the diagram the
  // student was still discussing vanish from the drawer mid-conversation.
  //
  // Prefers the first-class field; the regex scrape stays only for turns
  // stored before visualHtml was persisted. `pinnedVisual` lets "বড় করে দেখো"
  // on an older message override this.
  const latestHtml = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m.role !== "assistant") continue;
      const html = m.visualHtml ?? extractVisualHtml(m.content).html;
      if (html) return html;
    }
    return null;
  }, [messages]);
  const drawerHtml = pinnedVisual ?? latestHtml;
  // A video lesson is the main content while it's playing, and a 400px column
  // makes its diagrams and captions too small to read. Widen for video only —
  // an interactive widget is fine at the narrower width.
  const drawerWidth = latestVideoState ? 620 : 400;
  /** What the tool row acts on — the student's own last question, so "আরেকটা উপমা" means one about that. */
  const lastStudentQuestion = useMemo(
    () => [...messages].reverse().find((m) => m.role === "user")?.content ?? null,
    [messages],
  );
  const hasVisualContent = Boolean(latestVideoState || drawerHtml);

  /**
   * Builds (or fetches) this turn's lesson, polling while the server works.
   *
   * The server never blocks on a build — it is director + per-scene narration +
   * code generation + rendering + assembly, ~90s cold — because no proxy will
   * hold a request open that long: the Next dev rewrite cuts at exactly 30s
   * with a bare, non-JSON 500, which is why video silently never appeared in
   * the browser while working perfectly against :4000. So it returns
   * `generating: true` and we ask again. Repeat requests are deduped
   * server-side, so polling costs nothing and never builds twice.
   */
  async function buildVideoLesson(messageId: string, source: WatchSource): Promise<void> {
    setVideoLessons((prev) => ({ ...prev, [messageId]: { status: "loading" } }));
    setVisualOpen(true);

    const body = { ...source, subject, chapter, ...(nodeId ? { nodeId } : {}) };

    try {
      let response = await api.post<VideoLessonResponse>("/video/build", body);

      // Playable means there is something to render: scenes with their own
      // audio, an assembled lesson file, or a legacy single-track script.
      const isPlayable = (r: VideoLessonResponse): boolean =>
        r.scenes.length > 0 || Boolean(r.lessonUrl) || Boolean(r.audioUrl);

      if (isPlayable(response.data)) {
        setVideoLessons((prev) => ({ ...prev, [messageId]: { status: "ready", data: response.data } }));
      }

      for (let attempt = 0; response.data.generating && attempt < VIDEO_POLL_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, VIDEO_POLL_INTERVAL_MS));
        response = await api.post<VideoLessonResponse>("/video/build", body);
        if (isPlayable(response.data)) {
          setVideoLessons((prev) => ({ ...prev, [messageId]: { status: "ready", data: response.data } }));
          break;
        }
        // The server gave up for good (budget, or a build that failed outright)
        // — stop polling rather than spinning for another three minutes.
        if (response.data.failed) break;
      }

      if (!isPlayable(response.data)) {
        setVideoLessons((prev) => ({ ...prev, [messageId]: { status: "error" } }));
      }
    } catch {
      setVideoLessons((prev) => ({ ...prev, [messageId]: { status: "error" } }));
    }
  }

  /** Reveals `fullText` into the message identified by `id` a bit at a time — the "typing" feel described in PLAN.md's streaming fine-tune, layered on top of a `final` SSE event rather than real per-token model streaming (see chat.routes.ts's own note on why). */
  function revealAssistantMessage(id: string, fullText: string): void {
    if (revealTimerRef.current) clearInterval(revealTimerRef.current);

    if (!fullText) {
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, streaming: false } : m)));
      return;
    }

    const duration = Math.min(REVEAL_MAX_MS, fullText.length * REVEAL_MS_PER_CHAR);
    const ticks = Math.max(1, Math.round(duration / REVEAL_TICK_MS));
    const charsPerTick = Math.max(1, Math.ceil(fullText.length / ticks));
    let revealed = 0;

    revealTimerRef.current = setInterval(() => {
      revealed = Math.min(fullText.length, revealed + charsPerTick);
      const done = revealed >= fullText.length;
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, content: fullText.slice(0, revealed), streaming: !done } : m)),
      );
      if (done && revealTimerRef.current) {
        clearInterval(revealTimerRef.current);
        revealTimerRef.current = null;
      }
    }, REVEAL_TICK_MS);
  }

  function isErrorMessage(err: unknown): string | undefined {
    if (err && typeof err === "object" && "response" in err) {
      const response = (err as { response?: { data?: { error?: string } } }).response;
      return response?.data?.error;
    }
    return undefined;
  }

  /**
   * The slot a draft becomes on its first send: the next one unused for this
   * (subject, chapter). Re-fetches the list rather than trusting page state,
   * which may still be loading or be stale from another tab.
   */
  async function claimDraftSlot(): Promise<number> {
    let list = conversations;
    try {
      const res = await api.get<{ conversations: ConversationSummary[] }>("/chat/conversations");
      list = res.data.conversations;
    } catch {
      /* fall back to the list already loaded */
    }
    return nextConversationSlot(list, subject, chapter);
  }

  async function sendMessage(rawMessage: string): Promise<void> {
    const message = rawMessage.trim();
    if (!message || sending) return;

    const userMessage: ChatMessageData = { id: crypto.randomUUID(), role: "user", content: message };
    const assistantId = crypto.randomUUID();

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setSending(true);
    setStage(null);
    setError(null);

    let placedAssistant = false;

    const epoch = threadEpochRef.current;
    let slot = conversationSlot;
    if (slot === null) {
      slot = await claimDraftSlot();
      if (threadEpochRef.current !== epoch) return; // left this draft while the slot was being claimed
      adoptedThreadRef.current = `${subject}::${chapter}::${slot}`;
      router.replace(
        `/chat?subject=${encodeURIComponent(subject)}&chapter=${chapter}&conversationSlot=${slot}` +
          (topicId ? `&topic=${encodeURIComponent(topicId)}` : "") +
          (nodeId ? `&nodeId=${encodeURIComponent(nodeId)}` : ""),
      );
    }

    await streamChat(
      {
        message,
        subject,
        chapter,
        conversationSlot: slot,
        ...(topicId ? { topicId } : {}),
        ...(nodeId ? { nodeId } : {}),
      },
      {
        onStage: setStage,
        onFinal: (result: ChatResponse) => {
          if (threadEpochRef.current !== epoch) {
            loadConversations(); // the turn was still saved — just not into the thread now on screen
            return;
          }
          setSending(false);
          setStage(null);
          placedAssistant = true;

          setMessages((prev) => [
            ...prev,
            {
              id: assistantId,
              role: "assistant",
              content: "",
              responseType: result.responseType,
              reasoning: result.reasoning,
              visualHtml: result.visualHtml,
              suggestions: result.suggestions,
              videoBrief: result.videoBrief,
              streaming: true,
            },
          ]);
          revealAssistantMessage(assistantId, result.content);
          setProfileSnapshot(result.profileSnapshot);
          setPinnedVisual(null);
          setPinnedVideoId(null);
          loadConversations();

          // Mirrors chat.service.ts's own advanceLessonSession: it runs
          // unconditionally whenever this turn had an active lesson context,
          // so the same condition here keeps the badge in step with the
          // server without a second round-trip just to re-fetch lesson state.
          setLesson((prev) => {
            if (!prev || prev.status !== "ACTIVE") return prev;
            const isLastStep = prev.currentStep === prev.outlineLength - 1;
            return isLastStep
              ? { ...prev, status: "READY_FOR_MASTERY" }
              : { ...prev, currentStep: prev.currentStep + 1 };
          });

          if (result.responseType === "VIDEO" && result.videoBrief) {
            buildVideoLesson(assistantId, { videoBrief: result.videoBrief });
          } else if (result.responseType === "CANVAS") {
            setVisualOpen(true);
          }
        },
        onError: (msg: string) => {
          if (threadEpochRef.current !== epoch) return;
          setSending(false);
          setStage(null);
          if (!placedAssistant) setError(msg);
        },
      },
    );
  }

  /**
   * The interactive half of the loop: a widget reporting what the student did
   * becomes an ordinary chat turn, so the tutor reacts to the actual
   * interaction rather than to a message the student had to type themselves.
   *
   * `event` has already been source-, shape-, length- and rate-checked by
   * VisualSandbox before it reaches here — but it still originated in
   * model-generated code running in a sandbox, so it is only ever used as
   * message *text*, never as markup or as a command.
   */
  function handleWidgetEvent(event: WidgetEvent): void {
    if (sending) return;

    if (event.type === "ask") {
      sendMessage(event.question);
      return;
    }

    const what = event.detail ? ` (${event.detail})` : "";
    sendMessage(
      event.correct
        ? `ভিজ্যুয়ালটায় চেষ্টা করে ঠিক উত্তর পেয়েছি${what}। কেন এটা ঠিক, একটু বুঝিয়ে বলবে?`
        : `ভিজ্যুয়ালটায় চেষ্টা করে ভুল করেছি${what}। কোথায় ভুল করলাম, বুঝিয়ে বলো তো?`,
    );
  }

  /**
   * Replays a past turn's video on demand.
   *
   * Deliberately not automatic on page load: that would fire one build per
   * historical video turn at once. On demand it is cheap — the clip comes from
   * the shared library and the narration from the TTS cache, so a replay is
   * usually $0 and a few seconds.
   */
  function handleWatchVideo(messageId: string, source: WatchSource): void {
    setPinnedVideoId(messageId);
    setVisualOpen(true);
    if (!videoLessons[messageId]) buildVideoLesson(messageId, source);
  }

  function handleSubmit(e: FormEvent): void {
    e.preventDefault();
    sendMessage(input);
  }

  // Completion is no longer something this page can assert — it's the result of
  // passing the level's Mastery Check, graded server-side. This callback only
  // reports what the server decided.
  function handleMasteryPassed(result: SubmitMasteryResponse): void {
    const unlocked = result.progress?.newlyUnlockedNodeIds.length ?? 0;
    setCompleteStatus(
      `লেভেল সম্পন্ন হয়েছে ${result.score}% স্কোরে — +${result.progress?.xpAwarded ?? 0} XP` +
        (unlocked > 0 ? ` · ${unlocked}টি নতুন লেভেল আনলক হয়েছে` : ""),
    );
  }

  /** Reopens a past (subject, chapter, conversationSlot) thread — shared by the sidebar list and the empty-state's "recent conversations" quick-resume. */
  function openConversation(c: ConversationSummary): void {
    router.push(conversationHref(c));
  }

  /** The picker's onChange — retargets the draft (no slot), so picking a chapter or topic never reopens one of its existing threads. */
  function switchTopic(target: ChatTopicTarget): void {
    router.push(
      `/chat?subject=${encodeURIComponent(target.subject)}&chapter=${target.chapter}` +
        (target.topicId ? `&topic=${encodeURIComponent(target.topicId)}` : ""),
    );
  }

  const activeChapterOption = isGeneral
    ? undefined
    : chapterOptions.find((o) => o.subject === subject && o.chapter === chapter);
  const activeTopicOption = topicId ? activeChapterOption?.topics.find((t) => t.id === topicId) : undefined;

  /** "নতুন কথোপকথন": back to the blank start page with the composer focused. Already there (a bare /chat with nothing sent), navigation would be a no-op — so just focus, which is the visible response. */
  function startNewConversation(): void {
    setSidebarOpen(false);
    if (isDraft && isGeneral && messages.length === 0 && searchParams.toString() === "") {
      composerRef.current?.focus();
      return;
    }
    setInput("");
    focusComposerRef.current = true;
    router.push("/chat");
  }

  const sidebarPane = (
    <ChatSidebar
      conversations={conversations}
      loading={conversationsLoading}
      activeSubject={subject}
      activeChapter={chapter}
      activeConversationSlot={conversationSlot}
      onNavigate={() => setSidebarOpen(false)}
      onNewConversation={startNewConversation}
    />
  );
  return (
    <>
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0 bg-background/50">
        <motion.div 
          animate={{ x: [0, 60, 0], y: [0, -40, 0], scale: [1, 1.1, 1] }} 
          transition={{ duration: 15, repeat: Infinity, ease: "linear" }}
          className="absolute top-[5%] left-[5%] w-[45vw] h-[45vw] rounded-full bg-primary/15 blur-[120px]" 
        />
        <motion.div 
          animate={{ x: [0, -50, 0], y: [0, 60, 0], scale: [1, 1.2, 1] }} 
          transition={{ duration: 20, repeat: Infinity, ease: "linear" }}
          className="absolute bottom-[5%] right-[5%] w-[35vw] h-[35vw] rounded-full bg-tertiary/15 blur-[120px]" 
        />
        <motion.div 
          animate={{ x: [0, 40, 0], y: [0, 80, 0], scale: [1, 1.15, 1] }} 
          transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
          className="absolute top-[30%] left-[35%] w-[25vw] h-[25vw] rounded-full bg-secondary-fixed/20 blur-[100px]" 
        />
        {/* Subtle grid pattern overlay */}
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at center, currentColor 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      </div>

      <main className="flex gap-4 lg:gap-6 h-[calc(100dvh-104px)] w-full max-w-[1400px] mx-auto px-2 sm:px-4 lg:px-6 pb-6 relative z-10">
        
        {/* Floating Spatial Sidebar Island */}
        <aside className="hidden lg:flex w-72 shrink-0 flex-col overflow-hidden bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] relative z-10">
          {sidebarPane}
        </aside>

        {/* Mobile sidebar — same content, in a drawer. */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-72 bg-surface-container-lowest/90 backdrop-blur-2xl p-0 shadow-2xl border-r-outline-variant/20">
            <SheetTitle className="sr-only">কথোপকথনসমূহ</SheetTitle>
            {sidebarPane}
          </SheetContent>
        </Sheet>

        {/* Floating Spatial Chat Island */}
        <section className="flex min-w-0 flex-1 flex-col overflow-hidden bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] relative z-10">
          <div className="flex items-center justify-between gap-3 border-b border-outline-variant/20 bg-transparent px-5 py-4 lg:px-8 z-20">
          <div className="flex items-center gap-2 min-w-0">
            <Button
              variant="ghost"
              size="icon-sm"
              className="lg:hidden rounded-full"
              onClick={() => setSidebarOpen(true)}
              aria-label="কথোপকথনসমূহ দেখুন"
            >
              <Menu className="size-4" />
            </Button>
            <div className="min-w-0">
              {isGeneral ? (
                <h1 className="truncate font-headline-sm text-on-surface leading-tight">
                  {isDraft
                    ? "নতুন কথোপকথন"
                    : conversationSlot === 1
                      ? "সাধারণ আলোচনা"
                      : `সাধারণ আলোচনা #${conversationSlot}`}
                </h1>
              ) : (
                <>
                  <h1 className="truncate font-headline-sm text-on-surface leading-tight">
                    {activeChapterOption?.title ?? subject}
                  </h1>
                  <p className="truncate text-xs text-on-surface-variant">
                    {subject} · অধ্যায় {chapter}
                    {activeTopicOption && ` · ${activeTopicOption.code} ${activeTopicOption.title}`}
                    {isDraft ? " · নতুন কথোপকথন" : conversationSlot > 1 && ` #${conversationSlot}`}
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <TutorModeBadge snapshot={profileSnapshot} />
            {nodeId && <MasteryCheckPanel nodeId={nodeId} onPassed={handleMasteryPassed} />}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setVisualOpen((v) => !v)}
              aria-label={visualOpen ? "ভিজ্যুয়াল প্যানেল লুকান" : "ভিজ্যুয়াল প্যানেল দেখান"}
              className={`rounded-full ${hasVisualContent && !visualOpen ? "text-primary" : ""}`}
            >
              {visualOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
            </Button>
          </div>
        </div>

        {lesson && (
          <p className="flex items-center gap-1.5 px-4 pt-2 text-sm text-on-surface-variant lg:px-6">
            <BookOpenCheck className="size-3.5 text-primary" />
            {lesson.status === "READY_FOR_MASTERY"
              ? "গাইডেড লেসন সম্পন্ন — মাস্টারি চেকের জন্য প্রস্তুত!"
              : `গাইডেড লেসন · ধাপ ${lesson.currentStep + 1}/${lesson.outlineLength}`}
          </p>
        )}
        {completeStatus && <p className="px-4 pt-2 text-sm text-primary lg:px-6">{completeStatus}</p>}

        <div className="flex-1 overflow-y-auto relative">
          {messages.length === 0 && !sending ? (
            <div className="absolute inset-0 overflow-y-auto">
              {/* min-h-full (not a fixed height) so justify-center only centers
                  when the content is shorter than the viewport — once the
                  empty-state cards make it taller (real streak/XP + recent
                  conversations data varies in length), the box grows instead
                  of clipping its own top edge against the scroller. */}
              <div className="flex min-h-full flex-col items-center justify-center py-8">
                <ChatEmptyState onAsk={sendMessage} conversations={conversations} onOpenConversation={openConversation} />

                {/* Centered Input Box */}
                <div className="w-full max-w-4xl px-4 mt-2">
                  <form onSubmit={handleSubmit} className="mx-auto flex w-full flex-col gap-1 rounded-[2.5rem] bg-surface-container-lowest/80 backdrop-blur-2xl border border-outline-variant/30 shadow-[0_12px_40px_rgba(0,0,0,0.06)] p-3 transition-all duration-300 focus-within:shadow-[0_12px_40px_rgba(0,104,95,0.12)] focus-within:border-primary/40">
                    <textarea
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleSubmit(e as any);
                        }
                      }}
                      ref={composerRef}
                      placeholder="যেকোনো প্রশ্নের ছবি তোলো, লিখে জানাও বা মুখে বলো... যেমন: 'নিউটনের দ্বিতীয় সূত্রটি উদাহরণসহ প্রমাণ করো'"
                      className="max-h-40 min-h-[64px] w-full resize-none bg-transparent px-4 pt-4 text-[15px] md:text-base outline-none placeholder:text-on-surface-variant/50 font-body-lg leading-relaxed"
                      rows={1}
                    />
                    {/* Bottom utility row */}
                    <div className="flex items-center justify-between gap-2 px-2 pb-1 mt-2">
                      <ChatTopicPicker
                        subject={subject}
                        chapter={chapter}
                        topicId={topicId}
                        chapters={chapterOptions}
                        onChange={switchTopic}
                      />
                      <Button type="submit" disabled={sending || !input.trim()} className="rounded-full w-12 h-12 flex shrink-0 items-center justify-center bg-primary hover:bg-primary-container text-on-primary shadow-md transition-all active:scale-95 disabled:opacity-50 disabled:shadow-none">
                        <Send className="w-5 h-5 ml-0.5" />
                      </Button>
                    </div>
                  </form>
                </div>
              </div>
            </div>
          ) : (
            <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-6 lg:px-6">
              {messages.map((message, i) => (
                <ChatMessage
                  key={message.id}
                  message={message}
                  actionPills={
                    message.role === "assistant"
                      ? buildActionPills(findPrecedingUserQuestion(messages, i) ?? subject, {
                          responseType: message.responseType,
                          reasoning: message.reasoning,
                        })
                      : undefined
                  }
                  onPillClick={sendMessage}
                  onWidgetEvent={handleWidgetEvent}
                  onExpandVisual={(html) => {
                    setPinnedVisual(html);
                    setVisualOpen(true);
                  }}
                  onWatchVideo={handleWatchVideo}
                />
              ))}
              {sending && <ThinkingIndicator stage={stage} />}
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Bottom Input Box (Only when chatting) */}
        {messages.length > 0 && (
          <div className="bg-gradient-to-t from-background via-background to-transparent pt-6 pb-4 px-4 lg:px-6 relative z-10">
            {lastStudentQuestion && (
              <div className="mx-auto mb-4 flex max-w-3xl gap-2 overflow-x-auto pb-1 scrollbar-none">
                {buildTutorTools(lastStudentQuestion).map((tool) => (
                  <button
                    key={tool.label}
                    type="button"
                    disabled={sending}
                    onClick={() => sendMessage(tool.prompt)}
                    className="shrink-0 rounded-full border border-outline-variant/30 bg-surface-container-lowest/80 backdrop-blur-md px-4 py-2 text-xs font-label-md text-on-surface-variant transition-all hover:border-primary/50 hover:bg-surface-container-low hover:text-primary disabled:opacity-40"
                  >
                    {tool.label}
                  </button>
                ))}
              </div>
            )}

            <form onSubmit={handleSubmit} className="mx-auto flex max-w-3xl gap-2 items-end relative bg-surface-container-lowest/80 backdrop-blur-2xl rounded-[2rem] border border-outline-variant/40 p-2 shadow-[0_8px_32px_rgba(0,0,0,0.06)] focus-within:border-primary/50 focus-within:shadow-[0_8px_32px_rgba(0,104,95,0.12)] transition-all duration-300">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSubmit(e as any);
                  }
                }}
                placeholder={BOTTOM_COMPOSER_PLACEHOLDER}
                className="flex-1 max-h-40 min-h-[48px] resize-none rounded-3xl bg-transparent px-4 py-3.5 text-[15px] outline-none placeholder:text-on-surface-variant/50 leading-relaxed"
                rows={1}
              />
              <Button type="submit" size="icon" disabled={sending || !input.trim()} className="rounded-full w-12 h-12 mb-0.5 mr-0.5 bg-primary hover:bg-primary-container text-on-primary shrink-0 shadow-md transition-all active:scale-95 disabled:opacity-50 disabled:shadow-none">
                <Send className="size-5 ml-0.5" />
              </Button>
            </form>
          </div>
        )}
      </section>

      {/* Right: Floating Spatial Visual Drawer Island */}
      <AnimatePresence initial={false}>
        {visualOpen && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: drawerWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.3, type: "spring", bounce: 0, ease: "easeOut" }}
            className="hidden shrink-0 overflow-hidden bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] sm:block relative z-20"
          >
            <div className="flex h-full flex-col gap-4 p-5" style={{ width: drawerWidth }}>
              <h2 className="font-headline-sm text-on-surface px-1">ভিজ্যুয়াল ব্যাখ্যা</h2>

              {latestVideoState?.status === "loading" && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[1.5rem] border border-outline-variant/30 bg-surface-container-lowest/50 backdrop-blur-sm p-8 text-center text-sm text-on-surface-variant shadow-sm">
                  <Loader2 className="size-8 animate-spin text-primary" />
                  আপনার ভিডিও লেসন তৈরি হচ্ছে…
                </div>
              )}

              {latestVideoState?.status === "ready" && latestVideoState.data && activeVideoId && (
                <VideoLessonPlayer
                  videoId={activeVideoId}
                  lesson={latestVideoState.data}
                  subject={subject}
                  chapter={chapter}
                  reducedMotion={reducedMotion}
                />
              )}

              {latestVideoState?.status === "error" && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[1.5rem] border border-destructive/30 bg-destructive/5 backdrop-blur-sm p-8 text-center text-sm text-destructive shadow-sm">
                  ভিডিও লেসন তৈরি করা যায়নি। আবার জিজ্ঞাসা করে দেখুন।
                </div>
              )}

              {!latestVideoState && drawerHtml && (
                <div className="flex-1 rounded-[1.5rem] overflow-hidden border border-outline-variant/30 bg-surface-container-lowest/50 shadow-inner">
                  <VisualSandbox html={drawerHtml} onEvent={handleWidgetEvent} />
                </div>
              )}

              {!latestVideoState && !drawerHtml && (
                <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-[1.5rem] border border-outline-variant/30 bg-surface-container-lowest/30 backdrop-blur-sm p-8 text-center text-sm text-on-surface-variant/60 shadow-sm">
                  <ImageOff className="size-8 opacity-50" />
                  একটি ডায়াগ্রাম বা ভিডিও চেয়ে দেখুন, এখানে দেখা যাবে।
                </div>
              )}
            </div>
          </motion.aside>
        )}
      </AnimatePresence>
    </main>
    </>
  );
}

export default function ChatPage(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ChatPageInner />
    </Suspense>
  );
}
