import type { FastifyInstance } from "fastify";
import { Prisma } from "@shikkha-ai/database";
import type { ResponseType, VideoScript } from "./orchestrator";
import type { VideoBrief } from "../video/director.schema";
import type { ChatHistoryTurn } from "./prompt";

/**
 * Server-side conversation memory, scoped to (user, subject, chapter,
 * conversationSlot) — that quadruple IS the conversation in this app,
 * matching how /chat is already routed. Replaces the old client-held,
 * client-truncated, refresh-losing history: chat.service.ts now loads from
 * here instead of trusting the request body, and persists both turns here
 * after every reply.
 *
 * `conversationSlot` differentiates separate conversations for the SAME
 * (subject, chapter) — it's never used for retrieval or grade isolation
 * (that stays the exact classLevel/subject/chapter triple, guardrail #4).
 * Every caller that doesn't pass one lands in slot 1, which is every
 * existing entry point (Ask Question, Start Lesson, Mastery) — only the
 * explicit "start a new conversation" flow ever asks for slot 2, 3, ....
 *
 * A turn may also carry the `topicId` the student narrowed the conversation
 * to. It's a property of the turns, not part of the conversation's identity.
 */

const HISTORY_LOAD_LIMIT = 50;
const HISTORY_PROMPT_TURNS = 8; // matches buildHistoryBlock's own slice in prompt.ts
const DEFAULT_SLOT = 1;

export interface ChatMessageRecord {
  id: string;
  role: "user" | "assistant";
  content: string;
  responseType: ResponseType | null;
  reasoning: string | null;
  videoBrief: VideoBrief | null;
  /** LEGACY — turns stored before the Manim pipeline. */
  videoScript: VideoScript | null;
  /** The turn's interactive widget, so a rehydrated thread keeps its diagrams instead of losing every past one. */
  visualHtml: string | null;
  suggestions: string[];
  createdAt: Date;
}

export interface ConversationSummary {
  subject: string;
  chapter: number;
  conversationSlot: number;
  /** The topic the conversation's latest turn was narrowed to, so reopening it keeps that focus. */
  topicId: string | null;
  /** The textbook chapter's title (plus topic) when one is committed; else a level's title; else "{subject} · Chapter {chapter}". Numbered past the first slot so multiple threads for the same chapter are distinguishable. */
  title: string;
  lastMessageAt: Date;
  lastMessagePreview: string;
}

function toRecord(row: {
  id: string;
  role: string;
  content: string;
  responseType: string | null;
  reasoning: string | null;
  videoBrief: Prisma.JsonValue;
  videoScript: Prisma.JsonValue;
  visualHtml: string | null;
  suggestions: string[];
  createdAt: Date;
}): ChatMessageRecord {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    responseType: (row.responseType as ResponseType | null) ?? null,
    reasoning: row.reasoning,
    videoBrief: (row.videoBrief as unknown as VideoBrief | null) ?? null,
    videoScript: (row.videoScript as unknown as VideoScript | null) ?? null,
    visualHtml: row.visualHtml,
    suggestions: row.suggestions,
    createdAt: row.createdAt,
  };
}

/** Full turn history for one conversation, oldest first — what the /chat/history endpoint returns to hydrate the page on load. */
export async function loadHistory(
  app: FastifyInstance,
  userId: string,
  subject: string,
  chapter: number,
  conversationSlot: number = DEFAULT_SLOT,
): Promise<ChatMessageRecord[]> {
  const rows = await app.prisma.chatMessage.findMany({
    where: { userId, subject, chapter, conversationSlot },
    orderBy: { createdAt: "asc" },
    take: HISTORY_LOAD_LIMIT,
  });
  return rows.map(toRecord);
}

/** The last few turns, shaped for the orchestrator's prompt — replaces the client-supplied `history` field. */
export async function loadRecentHistoryForPrompt(
  app: FastifyInstance,
  userId: string,
  subject: string,
  chapter: number,
  conversationSlot: number = DEFAULT_SLOT,
): Promise<ChatHistoryTurn[]> {
  const rows = await app.prisma.chatMessage.findMany({
    where: { userId, subject, chapter, conversationSlot },
    orderBy: { createdAt: "desc" },
    take: HISTORY_PROMPT_TURNS,
    select: { role: true, content: true },
  });
  // Query is newest-first for an efficient LIMIT; the prompt wants oldest-first.
  return rows.reverse().map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
}

export interface AppendTurnParams {
  userId: string;
  subject: string;
  chapter: number;
  /** Defaults to 1 — every caller that doesn't set this (lesson.service.ts included) keeps landing in the one thread it always has. */
  conversationSlot?: number;
  /** The already-validated topic this turn was narrowed to (see chat.service.ts). */
  topicId?: string;
  role: "user" | "assistant";
  content: string;
  responseType?: ResponseType;
  reasoning?: string;
  videoBrief?: VideoBrief;
  visualHtml?: string;
  suggestions?: string[];
}

export async function appendTurn(app: FastifyInstance, params: AppendTurnParams): Promise<void> {
  await app.prisma.chatMessage.create({
    data: {
      userId: params.userId,
      subject: params.subject,
      chapter: params.chapter,
      conversationSlot: params.conversationSlot ?? DEFAULT_SLOT,
      topicId: params.topicId ?? null,
      role: params.role,
      content: params.content,
      responseType: params.responseType ?? null,
      reasoning: params.reasoning ?? null,
      videoBrief: (params.videoBrief as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      visualHtml: params.visualHtml ?? null,
      suggestions: params.suggestions ?? [],
    },
  });
}

/**
 * Strips the raw markdown syntax a stored assistant turn actually contains
 * (bold headings, fenced code, KaTeX delimiters) down to plain text for the
 * sidebar's preview snippet — found while redesigning the chat page: once
 * PROMPT.md §3 started asking the model to bold its section headings, the
 * unstripped preview started literally showing "**💡 Prerequisites Check**"
 * instead of a readable line.
 */
export function stripMarkdownForPreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ") // fenced code/canvas blocks
    .replace(/\*\*(.*?)\*\*/g, "$1") // bold
    .replace(/[*_`]/g, "") // stray emphasis/inline-code markers
    .replace(/\$\$?(.*?)\$\$?/g, "$1") // KaTeX delimiters
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The subject name for a conversation with no specific curriculum chapter —
 * mirrors GENERAL_SUBJECT in apps/web/lib/chat.ts. Can't share a literal
 * across the two workspaces (frontend and backend are separate packages),
 * so this is the one other place it's spelled out; keep both in sync if it
 * ever changes. Unlike an earlier version of this file, `chapter` is a true
 * fixed constant here (always 1) — `conversationSlot` is what differentiates
 * separate General threads now, the same mechanism used for real chapters.
 */
const GENERAL_SUBJECT = "General";

/** Picks the display title for one (subject, chapter, slot) thread: General gets a friendly Bangla name; otherwise the committed chapter's title, else a level's title, else "{subject} · Chapter {chapter}" — with the topic appended when the thread has one, and " #{slot}" past the first slot. */
export function resolveConversationTitle(params: {
  subject: string;
  chapter: number;
  conversationSlot: number;
  chapterTitle?: string;
  nodeTitle?: string;
  topic?: { code: string; title: string };
}): string {
  const { subject, chapter, conversationSlot, chapterTitle, nodeTitle, topic } = params;
  let base: string;
  if (subject === GENERAL_SUBJECT) base = "সাধারণ আলোচনা";
  else {
    base = chapterTitle ?? nodeTitle ?? `${subject} · Chapter ${chapter}`;
    if (topic) base = `${base} · ${topic.code} ${topic.title}`;
  }
  return conversationSlot === DEFAULT_SLOT ? base : `${base} #${conversationSlot}`;
}

/**
 * Distinct (subject, chapter, conversationSlot) threads this user has
 * chatted in, most recently active first — feeds the /chat sidebar. Titles
 * come from the student's own grade's committed chapters and topics where
 * they exist, since "Physics · Chapter 1" is a lot less useful than the
 * chapter's actual name.
 */
export async function listConversations(app: FastifyInstance, userId: string): Promise<ConversationSummary[]> {
  const grouped = await app.prisma.chatMessage.groupBy({
    by: ["subject", "chapter", "conversationSlot"],
    where: { userId },
    _max: { createdAt: true },
  });

  if (grouped.length === 0) return [];

  const sorted = grouped
    .filter((g): g is typeof g & { _max: { createdAt: Date } } => g._max.createdAt !== null)
    .sort((a, b) => b._max.createdAt.getTime() - a._max.createdAt.getTime());

  const user = await app.prisma.user.findUnique({ where: { id: userId }, select: { classLevel: true } });
  const pairs = sorted.map((g) => ({ subject: g.subject, chapterNumber: g.chapter }));

  const [chapters, nodes, latest] = await Promise.all([
    user
      ? app.prisma.chapter.findMany({
          where: { classLevel: user.classLevel, OR: pairs.map((p) => ({ subject: p.subject, number: p.chapterNumber })) },
          select: { subject: true, number: true, title: true },
        })
      : Promise.resolve([]),
    app.prisma.curriculumNode.findMany({
      where: { OR: pairs },
      orderBy: { orderIndex: "asc" },
      select: { subject: true, chapterNumber: true, title: true },
    }),
    Promise.all(
      sorted.map((g) =>
        app.prisma.chatMessage.findFirst({
          where: { userId, subject: g.subject, chapter: g.chapter, conversationSlot: g.conversationSlot },
          orderBy: { createdAt: "desc" },
          select: { content: true, topicId: true },
        }),
      ),
    ),
  ]);

  const topicIds = [...new Set(latest.map((m) => m?.topicId).filter((id): id is string => Boolean(id)))];
  const topics =
    topicIds.length > 0
      ? await app.prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, code: true, title: true } })
      : [];

  const chapterTitleByKey = new Map(chapters.map((c) => [`${c.subject}::${c.number}`, c.title]));
  const nodeTitleByKey = new Map<string, string>();
  for (const n of nodes) {
    const key = `${n.subject}::${n.chapterNumber}`;
    if (!nodeTitleByKey.has(key)) nodeTitleByKey.set(key, n.title);
  }
  const topicById = new Map(topics.map((t) => [t.id, t]));

  return sorted.map((g, i) => {
    const key = `${g.subject}::${g.chapter}`;
    const last = latest[i];
    const topic = last?.topicId ? topicById.get(last.topicId) : undefined;
    const preview = stripMarkdownForPreview(last?.content ?? "");
    return {
      subject: g.subject,
      chapter: g.chapter,
      conversationSlot: g.conversationSlot,
      topicId: topic?.id ?? null,
      title: resolveConversationTitle({
        subject: g.subject,
        chapter: g.chapter,
        conversationSlot: g.conversationSlot,
        chapterTitle: chapterTitleByKey.get(key),
        nodeTitle: nodeTitleByKey.get(key),
        topic,
      }),
      lastMessageAt: g._max.createdAt,
      lastMessagePreview: preview.length > 140 ? `${preview.slice(0, 140)}…` : preview,
    };
  });
}
