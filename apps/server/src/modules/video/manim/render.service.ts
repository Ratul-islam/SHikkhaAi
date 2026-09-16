import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { env, isManimRenderingEnabled } from "../../../config/env";
import { hasVideoStream, probeDurationMs } from "../ffmpeg.service";

/**
 * Runs model-generated Manim code, as safely as a process boundary allows
 * (PLAN.md §6).
 *
 * This is the only file in the codebase that executes code written by a model
 * with real process privileges, so the isolation is built here rather than
 * assumed. Three layers, in order:
 *
 *   1. `validateSceneSource` — an AST allowlist (validate.py) that runs BEFORE
 *      anything executes. Deny-by-default on node types, imports and names.
 *   2. this module's spawn — a scrubbed environment (built from nothing, so no
 *      secret can leak by omission), rlimits, a network namespace where the
 *      kernel allows one, a per-job temp directory, and a wall-clock kill.
 *   3. `probeRender` — ffprobe on the output, so a "successful" exit that
 *      produced garbage is still a failure.
 *
 * None of this is a boundary against a determined adversary. It is sized for
 * the realistic threat — our own model, under our own prompt, hallucinating
 * `os.system(...)` or an infinite loop — and every layer fails closed, into the
 * SVG fallback (PLAN.md §8).
 */

export type RenderFailureStage = "disabled" | "unhealthy" | "validate" | "render" | "probe";

export interface RenderSuccess {
  ok: true;
  buffer: Buffer;
  /** What ffprobe actually measured, which is NOT assumed to equal the target. */
  actualDurationMs: number;
  renderMs: number;
}

export interface RenderFailure {
  ok: false;
  stage: RenderFailureStage;
  /** Fed back verbatim to the code-gen retry (PLAN.md §8), so it must name the real problem. */
  error: string;
}

export type RenderResult = RenderSuccess | RenderFailure;

/* ── Locating our own Python files ──────────────────────────────────────────
 * `tsc` does not copy .py files into dist/, so a compiled server would look
 * for them beside the emitted .js and find nothing. The build script copies
 * them (see package.json `build`), and this falls back to the source tree so a
 * partial build fails loudly at the probe rather than silently at the first
 * student's lesson.
 */
function pythonAsset(name: string): string {
  return path.join(__dirname, name);
}

const VALIDATOR = (): string => pythonAsset("validate.py");
const RUNNER = (): string => pythonAsset("runner.py");

/**
 * Python is run with `-I` (isolated) and deliberately NOT `-I -S`.
 *
 * `-I` is the isolation that matters: it ignores every PYTHON* environment
 * variable and drops the user site directory and the script's own directory
 * from `sys.path`. Adding `-S` on top looks stricter and breaks the renderer
 * outright — it skips the `site` module, which is precisely what puts a venv's
 * `site-packages` on the path, so `import manim` fails with ModuleNotFoundError
 * and every scene silently degrades to SVG. Verified both ways.
 */
const PYTHON_ISOLATION_FLAG = "-I";

/* ── Scrubbed environment ───────────────────────────────────────────────────
 * Built from an empty object, never by spreading `process.env`. That direction
 * matters: this server's environment holds OPEN_ROUTER_API, DATABASE_URL,
 * JWT_* and the R2 secrets, and a spread-then-delete would leak every variable
 * anyone adds later. Allowlisting means a new secret is excluded by default.
 */
function sandboxEnv(jobDir: string): NodeJS.ProcessEnv {
  return {
    // Needed to find ffmpeg, latex and dvisvgm — the renderer shells out to
    // all three. Deliberately not inheriting the server's PATH.
    PATH: "/usr/local/bin:/usr/bin:/bin",
    // Every writable location points inside the job directory, which is
    // deleted afterwards. Manim, matplotlib and fontconfig all want a cache.
    HOME: jobDir,
    TMPDIR: jobDir,
    XDG_CACHE_HOME: path.join(jobDir, ".cache"),
    XDG_CONFIG_HOME: path.join(jobDir, ".config"),
    // Bangla is the entire point; a C locale here renders tofu boxes.
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PYTHONIOENCODING: "utf-8",
    // Byte-compiled caches in a directory we are about to delete are waste.
    PYTHONDONTWRITEBYTECODE: "1",
  };
}

/* ── Network isolation ──────────────────────────────────────────────────────
 * `unshare -rn` gives the render an empty network namespace, which turns any
 * egress attempt into `Network is unreachable`. It needs unprivileged user
 * namespaces, which some hardened kernels and most containers disable — so it
 * is PROBED once rather than assumed, and its absence downgrades the sandbox
 * instead of disabling the feature. The import allowlist is what actually
 * prevents a scene from opening a socket; this is defence in depth.
 */
let networkIsolationAvailable: boolean | null = null;

async function canIsolateNetwork(): Promise<boolean> {
  if (networkIsolationAvailable !== null) return networkIsolationAvailable;
  networkIsolationAvailable = await new Promise<boolean>((resolve) => {
    const probe = spawn("unshare", ["-rn", "true"], { stdio: "ignore" });
    probe.on("error", () => resolve(false));
    probe.on("close", (code) => resolve(code === 0));
  });
  return networkIsolationAvailable;
}

/* ── Spawning ───────────────────────────────────────────────────────────────*/

interface SpawnOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Runs one command under the sandbox, with a hard wall-clock ceiling.
 *
 * `detached: true` puts the child in its own process group so the kill can
 * target `-pid` — the whole group. Manim spawns ffmpeg and latex, and killing
 * only the direct child would leave those running after a timeout.
 */
function runSandboxed(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; input?: string },
): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
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
    }, options.timeoutMs);

    const settle = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      // A runaway print loop must not become a memory problem of ours.
      if (stdout.length < 200_000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 200_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      settle(null);
    });
    child.on("close", settle);

    if (options.input !== undefined) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

/* ── Layer 1: validation ────────────────────────────────────────────────────*/

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Runs the AST allowlist over the model's source.
 *
 * Uses the venv interpreter for consistency, but validate.py imports nothing
 * outside the standard library on purpose: a broken or half-installed venv must
 * still be able to REJECT code. Failing open here would be the worst bug in the
 * system, so an unusable validator is reported as a rejection.
 */
export async function validateSceneSource(source: string): Promise<ValidationResult> {
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-validate-"));
  try {
    const outcome = await runSandboxed(env.MANIM_PYTHON, [PYTHON_ISOLATION_FLAG, VALIDATOR()], {
      cwd: jobDir,
      env: sandboxEnv(jobDir),
      timeoutMs: 15_000,
      input: source,
    });

    if (outcome.code !== 0 || !outcome.stdout.trim()) {
      return {
        ok: false,
        errors: [`validator did not run: ${(outcome.stderr || "no output").slice(0, 400)}`],
      };
    }

    const parsed = JSON.parse(outcome.stdout) as ValidationResult;
    return { ok: Boolean(parsed.ok), errors: Array.isArray(parsed.errors) ? parsed.errors : [] };
  } catch (err) {
    return { ok: false, errors: [`validator error: ${(err as Error).message}`] };
  } finally {
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/* ── Concurrency ────────────────────────────────────────────────────────────
 * Rendering is free in dollars and expensive in CPU (PLAN.md §9.3), so this is
 * the meter that binds now. Without it, ten students starting lessons at once
 * would fork forty Manim processes and the server would stop answering
 * anything at all.
 */
let active = 0;
const waiting: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (active < env.MANIM_MAX_CONCURRENT) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function releaseSlot(): void {
  active -= 1;
  waiting.shift()?.();
}

/**
 * Runs other heavy media work — ffmpeg conform, mux, concat, narration
 * transcode — under the SAME limit as a render.
 *
 * The semaphore used to cover Manim alone, so a conform (up to ~190MB even
 * thread-capped) or a burst of narration transcodes could start on top of a
 * live render. On a 512MB server that overlap is an OOM kill, not a slowdown.
 * Never call this from inside renderScene or another withRenderSlot: the slot
 * is not re-entrant, and nesting would wait on itself.
 */
export async function withRenderSlot<T>(work: () => Promise<T>): Promise<T> {
  await acquireSlot();
  try {
    return await work();
  } finally {
    releaseSlot();
  }
}

/* ── Health ─────────────────────────────────────────────────────────────────*/

export interface HealthReport {
  healthy: boolean;
  manimVersion: string | null;
  networkIsolation: boolean;
  problems: string[];
}

let cachedHealth: HealthReport | null = null;

/**
 * Asserts the renderer can actually run, once, at boot.
 *
 * `MANIM_ENABLED=auto` resolves through this. Checked once and cached because
 * PLAN.md §3.2 wants a loud failure at startup rather than a per-request check
 * that quietly serves every lesson through the fallback.
 */
export async function checkRenderHealth(force = false): Promise<HealthReport> {
  if (cachedHealth && !force) return cachedHealth;

  const problems: string[] = [];
  let manimVersion: string | null = null;

  try {
    await fs.access(env.MANIM_PYTHON);
  } catch {
    problems.push(`no interpreter at ${env.MANIM_PYTHON} — run \`npm run setup:manim --workspace=apps/server\``);
  }

  for (const asset of [VALIDATOR(), RUNNER()]) {
    try {
      await fs.access(asset);
    } catch {
      problems.push(`missing ${path.basename(asset)} at ${asset}`);
    }
  }

  if (problems.length === 0) {
    const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-health-"));
    try {
      const outcome = await runSandboxed(
        env.MANIM_PYTHON,
        [PYTHON_ISOLATION_FLAG, "-c", "import manim, sys; sys.stdout.write(manim.__version__)"],
        { cwd: jobDir, env: sandboxEnv(jobDir), timeoutMs: 60_000 },
      );
      if (outcome.code === 0 && outcome.stdout.trim()) {
        manimVersion = outcome.stdout.trim();
      } else {
        problems.push(`manim did not import: ${(outcome.stderr || "no output").slice(0, 300)}`);
      }
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  cachedHealth = {
    healthy: problems.length === 0,
    manimVersion,
    networkIsolation: await canIsolateNetwork(),
    problems,
  };
  return cachedHealth;
}

/** Whether a render may be attempted at all — the kill switch AND the probe. */
export async function isRendererReady(): Promise<boolean> {
  if (!isManimRenderingEnabled()) return false;
  if (env.MANIM_ENABLED === "true") return true;
  return (await checkRenderHealth()).healthy;
}

/* ── The render ─────────────────────────────────────────────────────────────*/

export interface RenderRequest {
  /** Model-generated Manim source. Untrusted; validated before it runs. */
  source: string;
  /** Target length — the scene's own narration audio. Conformed exactly later (§7). */
  durationMs: number;
}

/** Content hash for the RenderedScene cache — identical source never re-renders. */
export function renderCacheKey(source: string, durationMs: number): string {
  return createHash("sha256")
    .update(`${env.MANIM_QUALITY}|${durationMs}|${source}`)
    .digest("hex");
}

export async function renderScene(request: RenderRequest): Promise<RenderResult> {
  if (!isManimRenderingEnabled()) {
    return { ok: false, stage: "disabled", error: "MANIM_ENABLED=false" };
  }
  if (!(await isRendererReady())) {
    const health = await checkRenderHealth();
    return { ok: false, stage: "unhealthy", error: health.problems.join("; ") || "renderer unhealthy" };
  }

  const validation = await validateSceneSource(request.source);
  if (!validation.ok) {
    return { ok: false, stage: "validate", error: validation.errors.join("\n") };
  }

  await acquireSlot();
  const startedAt = Date.now();
  const jobDir = await fs.mkdtemp(path.join(os.tmpdir(), "shikkha-render-"));

  try {
    const scenePath = path.join(jobDir, "scene.py");
    const outPath = path.join(jobDir, "out.mp4");
    // The runner reports through a FILE, not stdout: manim writes to stdout
    // itself (a LaTeX failure dumps the whole offending .tex document there),
    // which used to leave this parsing LaTeX source and reporting a bare
    // "exited with code 1" — throwing away the traceback that the code-gen
    // retry needs to actually repair the scene.
    const resultPath = path.join(jobDir, "result.json");
    await fs.writeFile(scenePath, request.source, "utf8");
    await fs.mkdir(path.join(jobDir, ".cache"), { recursive: true });
    await fs.mkdir(path.join(jobDir, ".config"), { recursive: true });

    const durationSec = (request.durationMs / 1000).toFixed(3);

    // rlimits are applied by the shell that execs the interpreter, so they are
    // inherited by manim's own children (ffmpeg, latex) too. `dash` rejects
    // several flags in one `ulimit` call — hence one call each, which is not a
    // style choice: combining them silently sets none of them.
    //   -v  ADDRESS SPACE, not resident memory — see env.MANIM_MEMORY_MB;
    //       a value sized from RSS fails every render at shared-object mmap
    //   -t  CPU seconds, which kills an infinite loop even while it produces no output
    //   -f  file size, in 512-byte blocks, so a runaway write can't fill the disk
    const limits = [
      `ulimit -v ${env.MANIM_MEMORY_MB * 1024}`,
      `ulimit -t ${Math.ceil(env.MANIM_SCENE_TIMEOUT_MS / 1000)}`,
      `ulimit -f ${400 * 1024 * 2}`, // 400 MB
    ].join("; ");

    const quoted = [env.MANIM_PYTHON, PYTHON_ISOLATION_FLAG, RUNNER(), scenePath, outPath, durationSec, env.MANIM_QUALITY, resultPath]
      .map((part) => `'${part.replace(/'/g, "'\\''")}'`)
      .join(" ");
    const script = `${limits}; exec ${quoted}`;

    const useNetns = await canIsolateNetwork();
    const [command, args] = useNetns
      ? (["unshare", ["-rn", "sh", "-c", script]] as const)
      : (["sh", ["-c", script]] as const);

    const outcome = await runSandboxed(command, [...args], {
      cwd: jobDir,
      env: sandboxEnv(jobDir),
      // The rlimit above bounds CPU; this bounds wall-clock, which is what
      // catches a process blocked on something rather than burning cycles.
      timeoutMs: env.MANIM_SCENE_TIMEOUT_MS,
    });

    if (outcome.timedOut) {
      return { ok: false, stage: "render", error: `render exceeded ${env.MANIM_SCENE_TIMEOUT_MS}ms and was killed` };
    }

    // The result file is authoritative whichever way the process exited — a
    // scene can fail with a clean exit, and can exit non-zero having still
    // written a useful traceback.
    const reported = await fs
      .readFile(resultPath, "utf8")
      .then((raw) => JSON.parse(raw) as { ok?: boolean; error?: string })
      .catch(() => null);

    if (outcome.code !== 0 || reported?.ok === false) {
      const detail =
        reported?.error ?? outcome.stderr.slice(-2000) ?? "";
      return { ok: false, stage: "render", error: detail || `renderer exited with code ${outcome.code}` };
    }

    // Layer 3. A zero exit that wrote a header is not a success: the duration
    // must be readable AND there must be an actual decodable video stream.
    const actualDurationMs = await probeDurationMs(outPath);
    if (actualDurationMs === null) {
      return { ok: false, stage: "probe", error: "output is not readable media" };
    }
    if (!(await hasVideoStream(outPath))) {
      return { ok: false, stage: "probe", error: "output carries no video stream" };
    }

    const buffer = await fs.readFile(outPath);
    if (buffer.length === 0) {
      return { ok: false, stage: "probe", error: "output file is empty" };
    }

    return { ok: true, buffer, actualDurationMs, renderMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, stage: "render", error: (err as Error).message };
  } finally {
    releaseSlot();
    await fs.rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
