import type { ConversationSummary } from "./types";

/**
 * The subject name for a conversation with no specific curriculum chapter —
 * "just ask something" rather than a curriculum chapter. `GENERAL_CHAPTER` is
 * a true fixed constant (always 1) — `conversationSlot` is what
 * differentiates separate General threads (see `nextConversationSlot`), the
 * exact same mechanism used for real curriculum chapters. `chat/page.tsx`
 * falls back to `(GENERAL_SUBJECT, GENERAL_CHAPTER)` when the URL names no
 * topic, as a DRAFT (no slot) — bare /chat is a blank start page, never an
 * existing thread.
 *
 * Nothing server-side is General-mode-specific except the friendly title
 * override in history.service.ts — mirror any change to these here.
 */
export const GENERAL_SUBJECT = "General";
export const GENERAL_CHAPTER = 1;

/** The /chat URL that reopens an existing conversation, keeping the topic it was narrowed to. */
export function conversationHref(
  c: Pick<ConversationSummary, "subject" | "chapter" | "conversationSlot" | "topicId">,
): string {
  return (
    `/chat?subject=${encodeURIComponent(c.subject)}&chapter=${c.chapter}&conversationSlot=${c.conversationSlot}` +
    (c.topicId ? `&topic=${encodeURIComponent(c.topicId)}` : "")
  );
}

/** True for any conversation under the General subject, regardless of which numbered slot. */
export function isGeneralConversation(subject: string): boolean {
  return subject === GENERAL_SUBJECT;
}

/**
 * The slot a draft conversation for (subject, chapter) claims on its first
 * send — the next one not already used by an existing thread for that exact
 * pair, so a new conversation is always genuinely blank (ChatGPT's "New
 * chat") instead of quietly appending to whichever thread happens to exist.
 * A thread with zero messages never appears in `conversations`
 * (`listConversations`'s own `groupBy` only returns pairs with at least one
 * `ChatMessage`), so an abandoned draft never burns a slot.
 *
 * Used for General (subject/chapter fixed, slot varies) and for real
 * curriculum chapters alike — the mechanism doesn't care which.
 */
export function nextConversationSlot(conversations: ConversationSummary[], subject: string, chapter: number): number {
  const usedSlots = conversations
    .filter((c) => c.subject === subject && c.chapter === chapter)
    .map((c) => c.conversationSlot);
  return usedSlots.length > 0 ? Math.max(...usedSlots) + 1 : 1;
}
