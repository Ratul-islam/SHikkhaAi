export type Role = "STUDENT" | "ADMIN";
export type NodeStatus = "LOCKED" | "UNLOCKED" | "COMPLETED";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  classLevel: number;
  xp: number;
  streakDays: number;
  emailVerified: boolean;
  avatarUrl: string | null;
}

export interface AuthTokenResponse {
  accessToken: string;
  user: AuthUser;
}

export interface MessageResponse {
  message: string;
}

/* ── Profile & preferences (Phase 5, expanded Phase 3) ────────────────────── */

export type Theme = "LIGHT" | "DARK" | "SYSTEM";

export interface UserSettingsView {
  theme: Theme;
  emailNotifications: boolean;
  dailyXpGoal: number;
  preferredSubject: string | null;
  timezone: string;
  reducedMotion: boolean;
}

export interface ProfileView {
  id: string;
  email: string;
  name: string;
  address: string | null;
  phone: string | null;
  avatarUrl: string | null;
  role: Role;
  classLevel: number;
  emailVerified: boolean;
  xp: number;
  streakDays: number;
  settings: UserSettingsView;
}

export interface UpdateProfileInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
}

export interface UpdateSettingsInput {
  theme?: Theme;
  emailNotifications?: boolean;
  dailyXpGoal?: number;
  preferredSubject?: string | null;
  timezone?: string;
  reducedMotion?: boolean;
}

export interface UpdateAvatarInput {
  regenerate?: true;
  avatarUrl?: string;
}

export interface UpdateClassResponse {
  accessToken: string;
  profile: ProfileView;
}

/* ── Progression & stats (Phase 3) ────────────────────────────────────────── */

export interface ClassProgressionRecord {
  classLevel: number;
  totalNodes: number;
  completedNodes: number;
  averageScore: number | null;
  xpEarned: number;
}

export interface ProfileStatsResponse {
  totalXp: number;
  streakDays: number;
  masteryAttemptsCount: number;
  masteryPassRate: number | null;
  completedNodesCount: number;
  dailyXpGoal: number;
  todayXp: number;
  perClass: ClassProgressionRecord[];
}

export interface EarnedBadgeView {
  key: string;
  title: string;
  description: string;
  icon: string;
  earnedAt: string;
}

export interface RoadmapNode {
  id: string;
  classLevel: number;
  subject: string;
  chapterNumber: number;
  title: string;
  description: string;
  prerequisites: string[];
  orderIndex: number;
  totalXp: number;
  status: NodeStatus;
  score: number | null;
}

export interface RoadmapResponse {
  nodes: RoadmapNode[];
}

/** Mirrors apps/server chat.schema.ts. */
export interface ChatTopicOption {
  id: string;
  /** "2.3" */
  code: string;
  title: string;
}

/** One askable chapter for the chat picker, with its topics. */
export interface ChatChapterOption {
  subject: string;
  chapter: number;
  /** Null when neither a committed chapter nor a level names it. */
  title: string | null;
  topics: ChatTopicOption[];
}

export interface ChatTopicsResponse {
  chapters: ChatChapterOption[];
}

export type ResponseType = "TEXT" | "CANVAS" | "VIDEO";

/** `history` removed — Phase 1.5 made this server-side conversation memory (see history.service.ts). */
export interface ChatRequestBody {
  message: string;
  subject: string;
  chapter: number;
  /** Differentiates separate conversations for the same (subject, chapter) — see lib/chat.ts and history.service.ts. Omitted (defaults to 1) unless the student explicitly started a new conversation. */
  conversationSlot?: number;
  /** A topic inside this chapter the conversation is narrowed to. */
  topicId?: string;
  /** Phase 6 — present whenever the thread is tied to a node, so the server can weave in an active guided lesson's next step. Harmless to always send: the server only acts on it if a LessonSession actually exists. */
  nodeId?: string;
}

export interface VisualCue {
  timeMs: number;
  animationType: string;
  highlightText: string;
  /** Phase 2 §2.3 — an optional self-contained HTML5 Canvas/SVG snippet for this cue, rendered sandboxed (see LessonComposition.tsx's CanvasCueOverlay). */
  canvasHtml?: string;
  /** Cues sharing a sceneId stay on the same diagram across several narration beats, instead of tearing it down and restarting on every cue. */
  sceneId?: string;
  /** Normalized 0-1 focal point inside the scene's diagram for this beat, so the camera can move to the part being talked about. */
  focusX?: number;
  focusY?: number;
}

/** Absent is treated as INTERACTIVE. FILE additionally renders a downloadable MP4; it never replaces the player. */
export type VideoDeliveryMode = "INTERACTIVE" | "FILE";

/**
 * LEGACY — the single-track script stored on VIDEO turns made before the Manim
 * pipeline. Still rendered, so old videos in a student's history keep playing
 * (PLAN.md §12); never produced any more.
 */
export interface VideoScript {
  title: string;
  narration: string;
  accentLocale: string;
  visualCues: VisualCue[];
  deliveryMode?: VideoDeliveryMode;
  /** Short Bangla concept label — the shared library's reuse key. */
  conceptKey?: string;
}

/**
 * What a VIDEO turn carries now: a brief, not a script.
 *
 * The Orchestrator decides a video is right and says what it should teach; the
 * server's director expands this into scenes at build time. Kept on the message
 * so a past turn can be replayed later, including after a reload.
 */
export interface VideoBrief {
  title: string;
  conceptKey: string;
  goal: string;
  analogy?: string;
}

/**
 * One scene of a built lesson.
 *
 * `durationMs` is measured from this scene's OWN narration audio, and
 * `startMs` is the sum of every earlier scene's duration — so the picture and
 * the words cannot drift apart. That is the whole point of the rebuild: the
 * old player had one narration track and a cue timeline shifted by the footage
 * length, which put every diagram a full reel out of step with its sentence.
 */
export interface LessonSceneView {
  id: string;
  startMs: number;
  durationMs: number;
  /** This scene's own narration. */
  audioUrl: string;
  /** The rendered Manim clip. Absent means this one scene fell back. */
  videoUrl?: string;
  narration: string;
  beats: LessonBeat[];
}

export interface LessonBeat {
  timeMs: number;
  highlightText: string;
  focusX?: number;
  focusY?: number;
}

export interface ProfileSnapshot {
  classLevel: number;
  visualPreferenceScore: number;
  languageMix: string;
  tutorModeLabel: string;
}

export interface ChatResponse {
  responseType: ResponseType;
  reasoning: string;
  content: string;
  /** What a VIDEO turn emits now. */
  videoBrief?: VideoBrief;
  /** LEGACY — only on turns stored before the Manim pipeline. */
  videoScript?: VideoScript;
  /** The turn's interactive widget, rendered sandboxed by VisualSandbox. */
  visualHtml?: string;
  /** Follow-up messages in the student's own voice; falls back to buildActionPills when absent. */
  suggestions?: string[];
  profileSnapshot: ProfileSnapshot;
}

/* ── Server-side chat history (Phase 1.5) ─────────────────────────────────── */

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  responseType: ResponseType | null;
  reasoning: string | null;
  videoBrief: VideoBrief | null;
  /** LEGACY — stored turns from before the Manim pipeline. */
  videoScript: VideoScript | null;
  visualHtml: string | null;
  suggestions: string[];
  createdAt: string;
}

export interface ConversationSummary {
  subject: string;
  chapter: number;
  /** Differentiates separate conversations for the same (subject, chapter) — see lib/chat.ts. */
  conversationSlot: number;
  /** The topic the thread is narrowed to, so reopening it keeps that focus. */
  topicId: string | null;
  title: string;
  lastMessageAt: string;
  lastMessagePreview: string;
}

export interface WordTiming {
  word: string;
  startMs: number;
  endMs: number;
}

export interface VideoLessonResponse {
  title: string;
  /** Empty for a lesson replayed from the shared library, which plays as `lessonUrl`. */
  scenes: LessonSceneView[];
  /** The assembled MP4 — the download, and how a library-reused lesson plays. */
  lessonUrl?: string;
  totalDurationMs: number;
  /** Lesson-relative, so karaoke captions and timestamp-ask work unchanged. */
  timestampManifest: WordTiming[];
  /** True while the build runs server-side — poll /video/build again. */
  generating: boolean;
  /** True when this came from the shared library and cost nothing. */
  reused: boolean;
  /** Set when the build failed for good — stop polling and say so. */
  failed?: string;

  /* Legacy replay only — one narration track driving `visualCues`. */
  videoScript?: VideoScript;
  audioUrl?: string;
}

export interface TimestampAskRequestBody {
  videoId: string;
  timestampMs: number;
  spokenSentence: string;
  userQuestion: string;
  subject: string;
  chapter: number;
}

export interface TimestampAskResponse {
  explanation: string;
}

export interface CurriculumNode {
  id: string;
  classLevel: number;
  subject: string;
  chapterNumber: number;
  title: string;
  description: string;
  prerequisites: string[];
  orderIndex: number;
  totalXp: number;
  sourcePages: number[];
  synthesized: boolean;
}

export interface CreateNodeInput {
  classLevel: number;
  subject: string;
  chapterNumber: number;
  title: string;
  description: string;
  prerequisites: string[];
  orderIndex: number;
  totalXp?: number;
}

export interface WeakTopic {
  nodeId: string;
  title: string;
  subject: string;
  classLevel: number;
  averageScore: number;
  attempts: number;
}

export interface NodePassRate {
  nodeId: string;
  title: string;
  subject: string;
  classLevel: number;
  chapterNumber: number;
  attempts: number;
  passRate: number;
}

export interface UncoveredChapter {
  classLevel: number;
  subject: string;
  chapter: number;
  chunkCount: number;
}

export interface AnalyticsResponse {
  studentCount: number;
  documentChunkCount: number;
  weakTopics: WeakTopic[];
  nodePassRates: NodePassRate[];
  uncoveredChapters: UncoveredChapter[];
}

export interface StudentListItem {
  id: string;
  name: string;
  email: string;
  classLevel: number;
  xp: number;
}

export interface StudentDrilldownResponse {
  userId: string;
  name: string;
  email: string;
  classLevel: number;
  xp: number;
  streakDays: number;
  profile: {
    visualPreferenceScore: number;
    mathRigidityScore: number;
    patienceLevel: number;
    languageMix: string;
    weakTopics: string[];
  };
  progress: {
    nodeId: string;
    nodeTitle: string;
    classLevel: number;
    subject: string;
    status: string;
    score: number;
    completedAt: string | null;
  }[];
  masteryHistory: {
    attemptId: string;
    nodeId: string;
    nodeTitle: string;
    score: number | null;
    passed: boolean | null;
    startedAt: string;
    submittedAt: string | null;
  }[];
}

export interface CompleteProgressResponse {
  nodeId: string;
  xpAwarded: number;
  totalXp: number;
  newlyUnlockedNodeIds: string[];
}

/* ── Mastery Check ─────────────────────────────────────────────────────────
 * Phase 1 generates MCQ only. `questionType` is carried through from the
 * server so NCTB's CQ/SQ paper types can be rendered later without reshaping
 * the client. The answer key is never part of a question — it only appears in
 * MasteryQuestionResult, after grading.
 */
export type MasteryQuestionType = "MCQ";

export interface MasteryQuestion {
  id: string;
  questionType: MasteryQuestionType;
  prompt: string;
  options: string[];
}

export interface StartMasteryResponse {
  attemptId: string;
  nodeId: string;
  nodeTitle: string;
  questions: MasteryQuestion[];
  passThreshold: number;
}

export interface MasteryQuestionResult {
  questionId: string;
  prompt: string;
  options: string[];
  selectedIndex: number | null;
  correctIndex: number;
  correct: boolean;
  explanation: string;
  sourcePage: number | null;
}

export interface SubmitMasteryResponse {
  attemptId: string;
  nodeId: string;
  score: number;
  passed: boolean;
  passThreshold: number;
  correctCount: number;
  totalQuestions: number;
  results: MasteryQuestionResult[];
  progress: CompleteProgressResponse | null;
  /** Phase 3 gamification — badges newly earned by this submission, for a one-time toast. */
  newBadges: { key: string; title: string; description: string; icon: string }[];
}

/* ── Level Synthesis ───────────────────────────────────────────────────── */

export interface DraftLevel {
  tempKey: string;
  title: string;
  description: string;
  orderIndex: number;
  prerequisiteKeys: string[];
  totalXp: number;
  sourcePages: number[];
}

export interface SynthesizeLevelsResponse {
  classLevel: number;
  subject: string;
  chapter: number;
  chunksAnalyzed: number;
  existingNodeCount: number;
  draft: DraftLevel[];
}

export interface BulkCreateNodesResponse {
  created: number;
  nodes: CurriculumNode[];
}

export interface ApiErrorResponse {
  error: string;
}

/* ── Whole-book ingestion (mirrors apps/server ingestion.schema.ts) ───────── */

export type IngestionJobStatus = "QUEUED" | "READING" | "READY_FOR_REVIEW" | "COMMITTING" | "COMMITTED" | "FAILED";

export interface IngestionJobSummary {
  id: string;
  fileName: string;
  classLevel: number;
  subject: string;
  status: IngestionJobStatus;
  pageCount: number;
  pagesDone: number;
  pagesFailed: number;
  costUsd: number;
  chunksInserted: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface DraftTopic {
  code: string;
  title: string;
  startPage: number;
  endPage: number;
}

export interface DraftChapter {
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  topics: DraftTopic[];
}

export interface DraftStructure {
  chapters: DraftChapter[];
  warnings: string[];
}

export interface CommittedChapterSummary {
  id: string;
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  topicCount: number;
  chunkCount: number;
}

export interface IngestionJobDetailResponse {
  job: IngestionJobSummary;
  draft: DraftStructure | null;
  failedPages: number[];
  /** Index = page - 1; null while the page is still waiting to be read. */
  pageKinds: (string | null)[];
  committedChapters: CommittedChapterSummary[];
  pdfAvailable: boolean;
}

export interface CreateIngestionJobResponse {
  job: IngestionJobSummary;
}

export interface IngestionPageView {
  pageNumber: number;
  pageKind: string;
  chapterNumber: number | null;
  chapterTitle: string | null;
  runningHeader: string;
  printedPageNumber: number | null;
  headings: { code: string; title: string }[];
  text: string;
  error: string | null;
}

export interface ChapterTopicView {
  id: string;
  code: string;
  title: string;
  startPage: number;
  endPage: number;
}

export interface ChapterView {
  id: string;
  classLevel: number;
  subject: string;
  number: number;
  title: string;
  startPage: number;
  endPage: number;
  jobId: string | null;
  chunkCount: number;
  topics: ChapterTopicView[];
}

/* ── Guided Lessons (Phase 6) ─────────────────────────────────────────────── */

export type LessonSessionStatus = "ACTIVE" | "READY_FOR_MASTERY" | "ABANDONED";

export interface LessonStep {
  title: string;
  goal: string;
}

export interface LessonTurn {
  responseType: ResponseType;
  reasoning: string;
  content: string;
  videoBrief?: VideoBrief;
  /** LEGACY — only on turns stored before the Manim pipeline. */
  videoScript?: VideoScript;
  visualHtml?: string;
  suggestions?: string[];
}

export interface StartLessonResponse {
  sessionId: string;
  nodeId: string;
  nodeTitle: string;
  subject: string;
  chapter: number;
  outline: LessonStep[];
  currentStep: number;
  status: LessonSessionStatus;
  /** Null when resuming an already-ACTIVE session — see lesson.service.ts. */
  turn: LessonTurn | null;
}
