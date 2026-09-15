import OpenAI from "openai";
import { env, isOpenRouterConfigured } from "../config/env";

/**
 * Two providers, deliberately — they are not interchangeable here.
 *
 * CHAT (`chatClient`) runs on OpenRouter. It replaced Google AI Studio's
 * compatibility endpoint, whose free tier capped each *individual model name*
 * at 20 requests/day per Cloud project (a new API key under the same project
 * did not reset it). That cap shaped a lot of this codebase's history — it's
 * why the evaluator is regex-based rather than a second model call, and why
 * past turns never auto-rebuild their videos. Chat is credit-metered now, so
 * that specific constraint is gone; see CLAUDE.md guardrail #7.
 *
 * EMBEDDINGS (`embedTexts`/`embedText`) stay on Google AI Studio, and this is
 * not an oversight: OpenRouter serves no embeddings endpoint at all, and
 * `DocumentChunk.embedding` is a `vector(768)` column holding the entire
 * ingested NCTB corpus. Changing the embedding model would silently invalidate
 * every stored chunk — old and new vectors would share a dimension count while
 * meaning completely different things, so retrieval would degrade quietly
 * rather than fail loudly. Swapping it is a re-ingest, never a config change.
 *
 * If OPEN_ROUTER_API is missing, chat falls back to the OPENAI_* client so the
 * server still boots and answers (just back under the old quota).
 */

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

/** OpenRouter model id for every chat/structured-output call. Override with CHAT_MODEL_NAME. */
export const CHAT_MODEL = env.CHAT_MODEL_NAME;

/** Which provider `chatClient` actually ended up pointing at — logged at startup so a missing key is visible, not silent. */
export const CHAT_PROVIDER = isOpenRouterConfigured() ? "openrouter" : "openai-compatible-fallback";

const embeddingClient = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL,
  timeout: 25_000,
});

/**
 * Every chat completion in the app goes through this: the orchestrator, the
 * mastery-paper generator, level synthesis, the lesson outline, and the
 * timestamped re-explanation.
 *
 * The 60s timeout is not arbitrary. The old 25s was tuned when replies were
 * short text; a single turn can now emit an interactive widget plus a
 * multi-scene video script, which is a lot of tokens, and 25s had itself
 * become a source of failed turns.
 */
export const chatClient = isOpenRouterConfigured()
  ? new OpenAI({
      apiKey: env.OPEN_ROUTER_API,
      baseURL: env.OPENROUTER_BASE_URL,
      timeout: 60_000,
      // OpenRouter attribution headers — they also move a request off the
      // stricter anonymous rate class.
      defaultHeaders: {
        "HTTP-Referer": env.WEB_APP_URL,
        "X-Title": "ShikkhaAI",
      },
    })
  : embeddingClient;

/**
 * Embeds a batch of text inputs in a single request, preserving input order in
 * the returned array. Always the Google client — see the module note above.
 */
export async function embedTexts(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];

  const response = await embeddingClient.embeddings.create({
    model: EMBEDDING_MODEL,
    input: inputs,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

export async function embedText(input: string): Promise<number[]> {
  const embeddings = await embedTexts([input]);
  const embedding = embeddings[0];
  if (!embedding) {
    throw new Error("OpenAI embeddings API returned no result");
  }
  return embedding;
}
