import { getAccessToken, refreshSession } from "./api";
import type { ChatResponse } from "./types";

export type ChatStage = "retrieving" | "thinking" | "saving";

export interface StreamChatCallbacks {
  onStage?: (stage: ChatStage) => void;
  onFinal: (result: ChatResponse) => void;
  onError: (message: string) => void;
}

interface StreamChatInput {
  message: string;
  subject: string;
  chapter: number;
  /** Differentiates separate conversations for the same (subject, chapter) — see lib/chat.ts. Omitted defaults to 1 server-side. */
  conversationSlot?: number;
  nodeId?: string;
}

/**
 * Consumes POST /api/v1/chat/stream (chat.routes.ts's SSE route) via plain
 * `fetch` — axios (`lib/api.ts`'s `api` instance) doesn't expose a
 * streaming response body in the browser, so this bypasses it rather than
 * fighting it. Auth is handled by hand here for the same reason: a 401 is
 * retried once against a fresh token via the same `refreshSession()`
 * singleton axios's interceptor uses, so a stream request never races a
 * concurrent refresh from elsewhere on the page.
 */
export async function streamChat(input: StreamChatInput, callbacks: StreamChatCallbacks, isRetry = false): Promise<void> {
  const token = getAccessToken();
  const response = await fetch("/api/v1/chat/stream", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(input),
  });

  if (response.status === 401 && !isRetry) {
    const session = await refreshSession();
    if (session) {
      return streamChat(input, callbacks, true);
    }
  }

  if (!response.ok || !response.body) {
    let message = "কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।";
    try {
      const body = await response.json();
      if (typeof body?.error === "string") message = body.error;
    } catch {
      // Not JSON (e.g. a 429 from the rate limiter, or a proxy error page) — keep the generic message.
    }
    callbacks.onError(message);
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line; a frame may still be
    // incomplete at the end of `buffer` if it arrived split across chunks.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice("event: ".length).trim();
      const data = JSON.parse(dataLine.slice("data: ".length));

      if (event === "stage") callbacks.onStage?.(data.stage);
      else if (event === "final") callbacks.onFinal(data as ChatResponse);
      else if (event === "error") callbacks.onError(data.error ?? "কিছু একটা সমস্যা হয়েছে। আবার চেষ্টা করুন।");
    }
  }
}
