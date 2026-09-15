/**
 * Creates the dedicated render virtualenv at apps/server/.venv-manim.
 *
 *   npm run setup:manim --workspace=apps/server
 *
 * Deliberately its own interpreter rather than the system Python. Two reasons:
 * Debian-family Pythons are externally managed (PEP 668) and refuse a plain
 * `pip install` outright, and pinning the render environment (§16) is only
 * meaningful if nothing else shares it.
 *
 * Idempotent: re-running upgrades to whatever manim-requirements.txt pins.
 */

import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const SERVER_ROOT = path.join(__dirname, "..");
const VENV_DIR = path.join(SERVER_ROOT, ".venv-manim");
const VENV_PYTHON = path.join(VENV_DIR, "bin", "python");
const REQUIREMENTS = path.join(SERVER_ROOT, "manim-requirements.txt");

function run(command: string, args: string[], label: string): void {
  process.stdout.write(`\n▸ ${label}\n`);
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw new Error(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} exited with code ${result.status}`);
}

/**
 * Manim renders text through Pango and equations through LaTeX. Neither is a
 * pip dependency, so a venv can install perfectly and still produce tofu boxes
 * where the Bangla should be. Checking here means that surfaces as a setup
 * error rather than as a silently ugly video.
 */
function checkSystemDependencies(): string[] {
  const missing: string[] = [];

  for (const binary of ["ffmpeg", "ffprobe"]) {
    if (spawnSync("which", [binary]).status !== 0) missing.push(`${binary} (apt install ffmpeg)`);
  }
  if (spawnSync("which", ["latex"]).status !== 0) {
    missing.push("latex (apt install texlive texlive-latex-extra dvisvgm) — needed for MathTex");
  }
  const fonts = spawnSync("fc-list", [":family"], { encoding: "utf8" });
  if (!/Noto Sans Bengali/i.test(fonts.stdout ?? "")) {
    missing.push("Noto Sans Bengali font (apt install fonts-noto-bengali) — Bangla labels need it");
  }

  return missing;
}

function main(): void {
  process.stdout.write("Setting up the Manim render environment\n");

  if (!fs.existsSync(REQUIREMENTS)) {
    throw new Error(`missing ${REQUIREMENTS}`);
  }

  const missing = checkSystemDependencies();
  if (missing.length > 0) {
    process.stdout.write("\n⚠ system dependencies missing:\n");
    for (const item of missing) process.stdout.write(`   - ${item}\n`);
    process.stdout.write("\nInstall them, then re-run. Continuing with the venv anyway.\n");
  }

  if (!fs.existsSync(VENV_PYTHON)) {
    run("python3", ["-m", "venv", VENV_DIR], `creating venv at ${VENV_DIR}`);
  } else {
    process.stdout.write(`\n▸ reusing existing venv at ${VENV_DIR}\n`);
  }

  run(VENV_PYTHON, ["-m", "pip", "install", "--upgrade", "pip"], "upgrading pip");
  run(VENV_PYTHON, ["-m", "pip", "install", "-r", REQUIREMENTS], "installing pinned render dependencies");

  const version = spawnSync(VENV_PYTHON, ["-c", "import manim; print(manim.__version__)"], { encoding: "utf8" });
  if (version.status !== 0) {
    throw new Error(`manim did not import after install:\n${version.stderr}`);
  }

  process.stdout.write(`\n✓ manim ${version.stdout.trim()} ready at ${VENV_PYTHON}\n`);
  process.stdout.write("  Next: npm run verify:manim --workspace=apps/server\n");
}

try {
  main();
} catch (err) {
  process.stderr.write(`\n✗ ${(err as Error).message}\n`);
  process.exit(1);
}
