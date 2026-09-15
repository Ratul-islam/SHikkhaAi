import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type OpenAI from "openai";
import { chatClient } from "../../lib/openai";
import { env } from "../../config/env";
import { PAGE_READING_JSON_SCHEMA, PAGE_READING_PROMPT, parsePageReading, type PageReading } from "./page-reading";

/**
 * Reads one rendered textbook page with a vision model.
 *
 * NCTB PDFs draw their text as vector outlines, not a text layer: on the
 * Class 9-10 Physics book `pdftotext` finds characters on ~40 of 366 pages,
 * which is why the old pdf-parse ingestion turned a whole book into 84 chunks.
 * So each page is rasterized with poppler's `pdftoppm` and transcribed, and the
 * same call reports the structural cues (chapter opening, numbered headings,
 * running header) that structure.service.ts turns into chapters and topics.
 * The reading contract itself lives in page-reading.ts.
 *
 * poppler is invoked with an argument array and a minimal environment, never a
 * shell — the same rule ffmpeg.service.ts follows.
 */

/** A page read that failed after the model was already billed — the cost still belongs on the job. */
export class PageReadError extends Error {
  constructor(
    message: string,
    readonly costUsd: number,
  ) {
    super(message);
  }
}

const POPPLER_TIMEOUT_MS = 60_000;

interface CommandOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runPoppler(command: "pdfinfo" | "pdftoppm", args: string[]): Promise<CommandOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }, POPPLER_TIMEOUT_MS);

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (c: Buffer) => {
      if (stdout.length < 100_000) stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      if (stderr.length < 10_000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += err.message;
      settle(null);
    });
    child.on("close", (code) => settle(code));
  });
}

export async function countPdfPages(pdfPath: string): Promise<number> {
  const outcome = await runPoppler("pdfinfo", [pdfPath]);
  const match = /^Pages:\s+(\d+)/m.exec(outcome.stdout);
  if (outcome.code !== 0 || !match) {
    throw new Error(outcome.stderr.trim() || "pdfinfo could not read the file");
  }
  return Number(match[1]);
}

/** Rasterizes one page to PNG. `workDir` is scratch space owned by the caller. */
export async function renderPageToPng(
  pdfPath: string,
  pageNumber: number,
  workDir: string,
  dpi: number = env.INGEST_RENDER_DPI,
): Promise<Buffer> {
  const base = path.join(workDir, `p${pageNumber}-${dpi}`);
  const page = String(pageNumber);
  const outcome = await runPoppler("pdftoppm", ["-r", String(dpi), "-png", "-f", page, "-l", page, "-singlefile", pdfPath, base]);
  if (outcome.code !== 0) {
    throw new Error(outcome.timedOut ? `Rendering page ${pageNumber} timed out` : outcome.stderr.trim() || "pdftoppm failed");
  }
  const file = `${base}.png`;
  try {
    return await readFile(file);
  } finally {
    await rm(file, { force: true });
  }
}

function unwrapJson(content: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(content.trim());
  return fenced ? fenced[1]! : content;
}

/** One vision call. Throws PageReadError (carrying any billed cost) when the answer is unusable. */
export async function readPageImage(png: Buffer): Promise<{ reading: PageReading; costUsd: number }> {
  const params = {
    model: env.INGEST_MODEL,
    messages: [
      { role: "system", content: PAGE_READING_PROMPT },
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] },
    ],
    response_format: { type: "json_schema", json_schema: { name: "textbook_page", schema: PAGE_READING_JSON_SCHEMA } },
    // OpenRouter extension: report the actual charge on the response, so a
    // book's reading cost is measured rather than estimated.
    usage: { include: true },
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

  const completion = await chatClient.chat.completions.create(params);
  const costUsd = (completion.usage as { cost?: number } | undefined)?.cost ?? 0;
  const content = completion.choices[0]?.message?.content ?? "";

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(unwrapJson(content));
  } catch {
    /* handled below */
  }
  const reading = parsePageReading(parsed);
  if (!reading) {
    throw new PageReadError("The model returned an unreadable page result", costUsd);
  }
  return { reading, costUsd };
}
