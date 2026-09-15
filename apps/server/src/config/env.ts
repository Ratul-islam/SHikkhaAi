import path from "node:path";
import "dotenv/config";

export interface Env {
  PORT: number;
  DATABASE_URL: string;
  JWT_ACCESS_SECRET: string;
  JWT_REFRESH_SECRET: string;
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL: string | undefined;
  // Chat runs on OpenRouter; embeddings stay on the OPENAI_* pair above.
  // The key is read under the name it already has in .env (OPEN_ROUTER_API).
  // Optional at this layer for the same reason SMTP/OAuth are: lib/openai.ts
  // falls back to the OPENAI_* client when it's absent, so a missing key
  // degrades the chat provider instead of refusing to boot.
  OPEN_ROUTER_API: string | undefined;
  OPENROUTER_BASE_URL: string;
  CHAT_MODEL_NAME: string;
  /* ── Whole-book ingestion ───────────────────────────────────────────────
   * NCTB PDFs draw their text as vector outlines, so there is no text layer to
   * extract — every page is rendered and read by a vision model instead. */
  /** Vision model that reads each rendered page. Measured ~$0.0013 and ~4s per page on gemini-2.5-flash. */
  INGEST_MODEL: string;
  /** Pages read in parallel per job. */
  INGEST_CONCURRENCY: number;
  /** Render resolution for the page reader. 120 keeps small print legible at ~1.5k prompt tokens a page. */
  INGEST_RENDER_DPI: number;
  /** Where an uploaded book waits while it's read. Never uploads/ — that's swept after 24h. */
  INGEST_STORAGE_DIR: string;
  /**
   * Chunks embedded per minute while publishing a book. Google AI Studio's free
   * tier meters embeddings per input at 100/minute (a 429 beyond it); the
   * default leaves headroom for chat's per-turn embed. Raise on a paid tier.
   */
  INGEST_EMBED_PER_MINUTE: number;
  /* ── Lesson video (PLAN.md §3.2, §13) ──────────────────────────────────
   * Scenes are RENDERED by Manim, never bought per second. The old
   * VIDEO_GEN_* trio (veo/wan via OpenRouter `/videos`) is retired: it cost
   * $0.03/s, could not draw a Bangla label, and its fixed 4/6/8s SKUs are what
   * desynchronised every lesson. Those variables are ignored if still set. */
  /**
   * "auto" (default) enables the renderer when the boot health probe passes;
   * "false" is the kill switch. Deliberately NOT default-off: per PLAN.md §3.2
   * a renderer you have to remember to switch on is one that silently serves
   * every lesson through the degraded SVG fallback.
   */
  MANIM_ENABLED: "auto" | "true" | "false";
  /** Interpreter inside the dedicated venv. Never the system python — see setup-manim. */
  MANIM_PYTHON: string;
  /** Manim quality flag: l=480p15, m=720p30, h=1080p60. */
  MANIM_QUALITY: "l" | "m" | "h";
  /** Wall-clock ceiling for one scene render; ~45x the measured render time. */
  MANIM_SCENE_TIMEOUT_MS: number;
  /** How many renders may run at once — the CPU meter that replaced the USD one. */
  MANIM_MAX_CONCURRENT: number;
  /**
   * Address-space (RLIMIT_AS) ceiling per render process, MB.
   *
   * Address space, NOT resident memory — and the gap is large enough to be a
   * trap. A typical scene is ~380 MB resident but reserves **2294 MB of
   * virtual address space**, because numpy, scipy and av each map far more
   * than they touch. Sizing this from an RSS measurement produces
   * `failed to map segment from shared object` on every render, which reads
   * like a broken install rather than a limit. 4096 leaves real headroom over
   * the measured peak while still stopping a runaway allocation.
   */
  MANIM_MEMORY_MB: number;
  /** Retries after a validator rejection or a crashed render, with the error fed back. */
  MANIM_MAX_RETRIES: number;
  /** Hard ceiling on scenes per lesson. */
  VIDEO_MAX_SCENES: number;
  /** Hard ceiling on a lesson's total runtime. Replaces the 30s footage ceiling. */
  VIDEO_MAX_TOTAL_SEC: number;
  /** Daily ceiling per student, USD. Now guards TTS + model calls only; rendering is free. */
  VIDEO_DAILY_USD_PER_USER: number;
  /** Daily ceiling across every student, USD — the backstop against one bad day. */
  VIDEO_DAILY_USD_GLOBAL: number;
  /* ── Narration ─────────────────────────────────────────────────────────
   * "edge" is free and returns exact word timings; "gemini" sounds far
   * better but returns none, so timings are derived (see gemini-speech.service.ts). */
  TTS_ENGINE: "edge" | "gemini";
  TTS_MODEL: string;
  TTS_VOICE: string;
  /**
   * USD per second of synthesized speech, used to ESTIMATE narration spend.
   *
   * An estimate because OpenRouter's `/generation?id=` lookup 404s for TTS ids
   * (verified — the header is returned, the record is not queryable), so unlike
   * video there is no reported `usage.cost` to charge from. Derived from the
   * model's published token price at roughly 25 audio tokens/second; adjust
   * against a real invoice.
   */
  TTS_USD_PER_SECOND: number;
  /* ── Object storage for the shared lesson-video library ────────────────
   * Generated clips must NOT live in uploads/ — uploadsRetention.ts deletes
   * that directory's contents after 24h, which is right for throwaway
   * narration and catastrophic for a paid, reusable asset. */
  MEDIA_STORE: "local" | "r2" | "cloudinary";
  R2_ACCOUNT_ID: string | undefined;
  R2_BUCKET: string | undefined;
  R2_ACCESS_KEY_ID: string | undefined;
  R2_SECRET_ACCESS_KEY: string | undefined;
  R2_PUBLIC_BASE_URL: string | undefined;
  CLOUDINARY_CLOUD_NAME: string | undefined;
  CLOUDINARY_API_KEY: string | undefined;
  CLOUDINARY_API_SECRET: string | undefined;
  NODE_ENV: "development" | "production" | "test";
  // SMTP + OAuth are optional at the env layer, not required() — the server
  // must still boot without them. Each feature checks its own presence at
  // call time (email.ts, oauth.routes.ts) and fails that one request/route
  // rather than crashing startup. See .env.example for what to set.
  SMTP_HOST: string | undefined;
  SMTP_PORT: number | undefined;
  SMTP_USER: string | undefined;
  SMTP_PASSWORD: string | undefined;
  SMTP_FROM: string | undefined;
  GOOGLE_CLIENT_ID: string | undefined;
  GOOGLE_CLIENT_SECRET: string | undefined;
  GOOGLE_REDIRECT_URI: string | undefined;
  GITHUB_CLIENT_ID: string | undefined;
  GITHUB_CLIENT_SECRET: string | undefined;
  GITHUB_REDIRECT_URI: string | undefined;
  WEB_APP_URL: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env: Env = {
  PORT: process.env.PORT ? Number(process.env.PORT) : 4000,
  DATABASE_URL: required("DATABASE_URL"),
  JWT_ACCESS_SECRET: required("JWT_ACCESS_SECRET"),
  JWT_REFRESH_SECRET: required("JWT_REFRESH_SECRET"),
  OPENAI_API_KEY: required("OPENAI_API_KEY"),
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPEN_ROUTER_API: process.env.OPEN_ROUTER_API,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  CHAT_MODEL_NAME: process.env.CHAT_MODEL_NAME ?? "google/gemini-2.5-flash",
  INGEST_MODEL: process.env.INGEST_MODEL ?? "google/gemini-2.5-flash",
  INGEST_CONCURRENCY: Number(process.env.INGEST_CONCURRENCY ?? "6"),
  INGEST_RENDER_DPI: Number(process.env.INGEST_RENDER_DPI ?? "120"),
  INGEST_STORAGE_DIR: process.env.INGEST_STORAGE_DIR ?? path.join(__dirname, "../../storage/ingest"),
  INGEST_EMBED_PER_MINUTE: Number(process.env.INGEST_EMBED_PER_MINUTE ?? "80"),
  MANIM_ENABLED:
    process.env.MANIM_ENABLED === "false" ? "false" : process.env.MANIM_ENABLED === "true" ? "true" : "auto",
  MANIM_PYTHON: process.env.MANIM_PYTHON ?? path.join(__dirname, "../../.venv-manim/bin/python"),
  MANIM_QUALITY:
    process.env.MANIM_QUALITY === "l" ? "l" : process.env.MANIM_QUALITY === "h" ? "h" : "m",
  MANIM_SCENE_TIMEOUT_MS: Number(process.env.MANIM_SCENE_TIMEOUT_MS ?? "120000"),
  MANIM_MAX_CONCURRENT: Number(process.env.MANIM_MAX_CONCURRENT ?? "2"),
  MANIM_MEMORY_MB: Number(process.env.MANIM_MEMORY_MB ?? "4096"),
  MANIM_MAX_RETRIES: Number(process.env.MANIM_MAX_RETRIES ?? "1"),
  VIDEO_MAX_SCENES: Number(process.env.VIDEO_MAX_SCENES ?? "6"),
  VIDEO_MAX_TOTAL_SEC: Number(process.env.VIDEO_MAX_TOTAL_SEC ?? "180"),
  VIDEO_DAILY_USD_PER_USER: Number(process.env.VIDEO_DAILY_USD_PER_USER ?? "0.50"),
  VIDEO_DAILY_USD_GLOBAL: Number(process.env.VIDEO_DAILY_USD_GLOBAL ?? "5"),
  TTS_ENGINE: process.env.TTS_ENGINE === "gemini" ? "gemini" : "edge",
  TTS_MODEL: process.env.TTS_MODEL ?? "google/gemini-3.1-flash-tts-preview",
  TTS_VOICE: process.env.TTS_VOICE ?? "Kore",
  TTS_USD_PER_SECOND: Number(process.env.TTS_USD_PER_SECOND ?? "0.0005"),
  MEDIA_STORE:
    process.env.MEDIA_STORE === "r2" ? "r2" : process.env.MEDIA_STORE === "cloudinary" ? "cloudinary" : "local",
  R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID ?? process.env.CLOUDEFLARE_ACCOUNT_ID,
  R2_BUCKET: process.env.R2_BUCKET ?? process.env.CLOUDEFLARE_BUCKET,
  // CLOUDEFLARE_* are the names already present in .env; supported as aliases
  // rather than renamed, since .env is not ours to edit (guardrail #3).
  R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? process.env.CLOUDEFLARE_ID,
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? process.env.CLOUDEFLARE_SECRET,
  R2_PUBLIC_BASE_URL: process.env.R2_PUBLIC_BASE_URL ?? process.env.CLOUDEFLARE_PUBLIC_URL,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  NODE_ENV: (process.env.NODE_ENV as Env["NODE_ENV"]) ?? "development",
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_FROM: process.env.SMTP_FROM,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI,
  GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
  GITHUB_REDIRECT_URI: process.env.GITHUB_REDIRECT_URI,
  WEB_APP_URL: process.env.WEB_APP_URL ?? "http://localhost:3000",
};

/**
 * Whether scene rendering may run at all.
 *
 * Only the explicit kill switch turns it off. There is no key and no budget to
 * check any more — rendering is local CPU and costs nothing, which is exactly
 * why the old three-way gate (enabled AND key AND budget) is gone. "auto"
 * still has to clear a health probe before a render is attempted; that lives in
 * render.service.ts, because it involves touching the filesystem.
 */
export function isManimRenderingEnabled(): boolean {
  return env.MANIM_ENABLED !== "false";
}

/** Gemini TTS needs the same OpenRouter key; without it narration silently stays on free Edge-TTS. */
export function isGeminiTtsConfigured(): boolean {
  return Boolean(env.TTS_ENGINE === "gemini" && env.OPEN_ROUTER_API);
}

/** True once an OpenRouter key is present — lib/openai.ts checks this to pick the chat provider. */
export function isOpenRouterConfigured(): boolean {
  return Boolean(env.OPEN_ROUTER_API);
}

/** True once every SMTP var is set — otp.service.ts checks this before trying to send. */
export function isEmailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASSWORD && env.SMTP_FROM);
}

/** True once Google OAuth is configured — oauth.routes.ts checks this before mounting behavior. */
export function isGoogleOAuthConfigured(): boolean {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI);
}

/** True once GitHub OAuth is configured — same pattern as isGoogleOAuthConfigured(). */
export function isGitHubOAuthConfigured(): boolean {
  return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET && env.GITHUB_REDIRECT_URI);
}
