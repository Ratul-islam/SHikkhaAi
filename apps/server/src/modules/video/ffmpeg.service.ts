import { spawn } from "node:child_process";

/**
 * Every ffmpeg/ffprobe invocation in the video pipeline.
 *
 * Kept in one place for the same reason ingestion.service.ts owns all the raw
 * `vector` SQL: these are shell-adjacent calls with exact argument orders that
 * are easy to get subtly wrong, and scattering them makes a bug in one copy
 * invisible in the others.
 *
 * Nothing here ever interpolates user or model text into a command string —
 * `spawn` with an argument array, never a shell.
 */

const DEFAULT_TIMEOUT_MS = 120_000;
const FFMPEG_PATH = "/usr/bin/ffmpeg";
const FFPROBE_PATH = "/usr/bin/ffprobe";

export interface FfmpegOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function run(command: string, args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FfmpegOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      // A minimal environment here too: these are invoked on behalf of
      // model-directed content, and there is no reason for ffmpeg to see the
      // server's secrets.
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
    }, timeoutMs);

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
      if (stderr.length < 100_000) stderr += c.toString("utf8");
    });
    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      settle(null);
    });
    child.on("close", settle);
  });
}

export async function runFfmpeg(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<FfmpegOutcome> {
  // `-nostdin` matters when several of these run concurrently: without it a
  // prompt on one can consume the parent's stdin and hang the whole batch.
  return run(FFMPEG_PATH, ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], timeoutMs);
}

/**
 * Container duration in milliseconds, or null when the file isn't readable
 * media. Works for audio and video alike — `format=duration` is a
 * container-level field, so no stream selector is needed.
 */
export async function probeDurationMs(filePath: string): Promise<number | null> {
  const outcome = await run(
    FFPROBE_PATH,
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    30_000,
  );
  const seconds = Number.parseFloat(outcome.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

/** True when the file actually carries a decodable video stream — a zero exit that wrote a header is not enough. */
export async function hasVideoStream(filePath: string): Promise<boolean> {
  const outcome = await run(
    FFPROBE_PATH,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", filePath],
    30_000,
  );
  return outcome.stdout.trim().startsWith("video");
}

/* ── Duration conforming (PLAN.md §7) ───────────────────────────────────────
 * The keystone of the sync guarantee.
 *
 * A generated scene will not reliably animate for exactly as long as its
 * narration, however firmly the prompt asks. So the rendered clip is never
 * TRUSTED to be the right length — it is CONFORMED to the audio here. That is
 * what makes "scene duration equals narration duration" hold even when the
 * code generator misbehaves, rather than being an aspiration that degrades
 * quietly.
 */

/** Beyond this, retiming would be visibly wrong, so the tail is held/cut instead. */
export const MAX_RETIME_RATIO = 0.15;

export type ConformAction = "none" | "pad" | "retime" | "trim";

export function planConform(
  actualMs: number,
  targetMs: number,
): { action: ConformAction; ratio: number } {
  if (actualMs <= 0 || targetMs <= 0) return { action: "none", ratio: 1 };

  const ratio = targetMs / actualMs;
  // Under ~1 frame at 30fps there is nothing to fix.
  if (Math.abs(targetMs - actualMs) < 34) return { action: "none", ratio: 1 };

  // Short: hold the last frame. Always correct, never distorts the motion,
  // and reads as a beat of stillness while the narration finishes its sentence.
  if (actualMs < targetMs) return { action: "pad", ratio };

  // Long, but only slightly: a gentle retime is invisible and keeps the whole
  // animation.
  if (ratio >= 1 - MAX_RETIME_RATIO) return { action: "retime", ratio };

  // Long by a lot: the scene overran badly. Cutting is honest; stretching the
  // audio or slowing the motion by 30% would look broken.
  return { action: "trim", ratio };
}

/**
 * Rewrites `inputPath` so it lasts exactly `targetMs`, writing `outputPath`.
 *
 * Re-encodes rather than stream-copying: padding and retiming both change the
 * frame timeline, and a stream copy would leave the container claiming a
 * duration the frames don't support.
 */
export async function conformVideoDuration(
  inputPath: string,
  outputPath: string,
  targetMs: number,
): Promise<{ ok: boolean; action: ConformAction; error?: string }> {
  const actualMs = await probeDurationMs(inputPath);
  if (actualMs === null) return { ok: false, action: "none", error: "input is not readable media" };

  const { action, ratio } = planConform(actualMs, targetMs);
  const targetSec = (targetMs / 1000).toFixed(3);

  const filters: string[] = [];
  switch (action) {
    case "pad":
      // clone the final frame for the remainder
      filters.push(`tpad=stop_mode=clone:stop_duration=${((targetMs - actualMs) / 1000).toFixed(3)}`);
      break;
    case "retime":
      // setpts multiplies presentation timestamps: >1 slows, <1 speeds up.
      filters.push(`setpts=${(1 / ratio).toFixed(6)}*PTS`);
      break;
    case "trim":
    case "none":
      break;
  }

  const args = [
    "-i",
    inputPath,
    ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
    // `-t` after the filters is the belt to the filter's braces: whatever the
    // graph produced, the output is exactly this long.
    "-t",
    targetSec,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-an",
    outputPath,
  ];

  const outcome = await runFfmpeg(args);
  if (outcome.code !== 0) {
    return { ok: false, action, error: outcome.stderr.slice(-500) || `ffmpeg exited ${outcome.code}` };
  }
  return { ok: true, action };
}

/**
 * Muxes one silent scene clip with its own narration into a standalone MP4.
 *
 * `-shortest` is deliberately absent: the clip has already been conformed to
 * the audio, and adding it would let a rounding difference of a few
 * milliseconds silently shorten the scene — reintroducing drift at the exact
 * place this pipeline exists to remove it.
 */
export async function muxSceneAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const outcome = await runFfmpeg([
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    outputPath,
  ]);

  if (outcome.code !== 0) {
    return { ok: false, error: outcome.stderr.slice(-500) || `ffmpeg exited ${outcome.code}` };
  }
  return { ok: true };
}

/**
 * Concatenates finished scenes into the downloadable lesson.
 *
 * Uses the concat DEMUXER (a list file) rather than the concat filter: the
 * scenes were all produced by the same encoder at the same resolution and
 * frame rate, so they can be joined without re-encoding — which is both far
 * faster and lossless. `-safe 0` is required because the list holds absolute
 * paths.
 */
export async function concatScenes(
  listFilePath: string,
  outputPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const outcome = await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFilePath,
    "-c",
    "copy",
    // Concatenated streams can carry non-monotonic timestamps at each join;
    // without this ffmpeg warns and some players stutter at scene boundaries.
    "-fflags",
    "+genpts",
    outputPath,
  ]);

  if (outcome.code !== 0) {
    return { ok: false, error: outcome.stderr.slice(-500) || `ffmpeg exited ${outcome.code}` };
  }
  return { ok: true };
}

/** One line of a concat list file. Single quotes are the demuxer's escape, doubled to embed one. */
export function concatListLine(filePath: string): string {
  return `file '${filePath.replace(/'/g, "'\\''")}'`;
}
