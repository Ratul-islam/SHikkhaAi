/**
 * Proves the OpenRouter key, the model id, and the structured-output contract
 * all actually work — end to end, against the real endpoint, using the same
 * client and the same CHAT_MODEL the orchestrator uses.
 *
 * Written because the key could not be verified while this was being built:
 * a missing/expired key or a model without json_schema support both surface
 * as "chat is broken" at runtime rather than at boot, and this turns that
 * into one command.
 *
 *   npm run verify:openrouter --workspace=apps/server
 */

import { chatClient, CHAT_MODEL, CHAT_PROVIDER, EMBEDDING_MODEL, embedText } from "../src/lib/openai";
import { isOpenRouterConfigured } from "../src/config/env";

async function main(): Promise<void> {
  console.log(`provider    : ${CHAT_PROVIDER}`);
  console.log(`chat model  : ${CHAT_MODEL}`);
  console.log(`embed model : ${EMBEDDING_MODEL}`);

  if (!isOpenRouterConfigured()) {
    console.error("\n✗ OPEN_ROUTER_API is not set in apps/server/.env — chat is running on the old fallback client.");
    process.exit(1);
  }

  // 1. Structured output — the exact capability orchestrator.ts depends on.
  console.log("\n→ structured output (json_schema)…");
  const completion = await chatClient.chat.completions.create({
    model: CHAT_MODEL,
    messages: [
      { role: "system", content: "Reply in Bangla. Answer with JSON only." },
      { role: "user", content: "নিউটনের প্রথম সূত্র এক বাক্যে বলো।" },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "probe",
        schema: {
          type: "object",
          properties: { answer: { type: "string" } },
          required: ["answer"],
        },
      },
    },
  });

  const raw = completion.choices[0]?.message?.content ?? "";
  const parsed = JSON.parse(raw) as { answer?: string };
  if (!parsed.answer) throw new Error(`no answer field in structured response: ${raw}`);
  console.log(`✓ structured output works — "${parsed.answer.slice(0, 80)}…"`);

  // 2. Embeddings still go to the OTHER provider, and must still be 768-dim
  //    or every stored DocumentChunk vector becomes incomparable.
  console.log("\n→ embeddings (separate provider)…");
  const vector = await embedText("পরীক্ষা");
  if (vector.length !== 768) throw new Error(`expected 768 dimensions, got ${vector.length}`);
  console.log(`✓ embeddings work — ${vector.length} dimensions`);

  console.log("\nAll good. Chat and RAG are both live.");
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ ${message}`);
  process.exit(1);
});
