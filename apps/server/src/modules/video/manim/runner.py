"""Renders one validated Manim scene to one MP4 (PLAN.md §6, Layer 2).

Usage:  python runner.py <scene.py> <out.mp4> <duration_sec> <l|m|h> <result.json>

Runs inside the sandboxed subprocess render.service.ts spawns: scrubbed
environment, rlimits applied, no server secrets present. It is OUR code, not
the model's — the model's contribution is `<scene.py>`, which has already been
through validate.py by the time this runs.

Writes its JSON result to <result.json>, NOT to stdout:

    {"ok": true,  "path": "/abs/out.mp4", "durationSec": 12.3}
    {"ok": false, "error": "...traceback..."}

A file rather than stdout because manim writes to stdout itself — a LaTeX
compilation failure dumps the whole offending .tex document there, which left
the caller's `JSON.parse` looking at LaTeX source and falling back to a bare
"renderer exited with code 1". That silently threw away the traceback, which is
exactly the text the code-generation retry needs to repair the scene. A separate
file cannot be interleaved with.
"""

from __future__ import annotations

import json
import sys
import traceback

# Quality presets, spelled out rather than using manim's `-ql/-qm/-qh` strings
# so the numbers are visible where someone tuning render cost will look.
# Measured on the reference machine: 720p30 renders ~7.7s of animation in
# ~2.6s wall (PLAN.md §2); 480p15 is roughly 1.4x faster again.
QUALITY = {
    "l": (854, 480, 15),
    "m": (1280, 720, 30),
    "h": (1920, 1080, 60),
}


def write_result(result_path: str, payload: dict[str, object]) -> None:
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle)


def main() -> int:
    if len(sys.argv) != 6:
        sys.stderr.write("usage: runner.py <scene.py> <out.mp4> <duration> <quality> <result.json>\n")
        return 2

    scene_path, out_path, duration_raw, quality_key, result_path = sys.argv[1:6]
    width, height, fps = QUALITY.get(quality_key, QUALITY["m"])

    try:
        duration_sec = float(duration_raw)
    except ValueError:
        write_result(result_path, {"ok": False, "error": f"bad duration: {duration_raw!r}"})
        return 2

    try:
        from manim import Scene, config, tempconfig

        with open(scene_path, "r", encoding="utf-8") as handle:
            source = handle.read()

        # SCENE_DURATION is injected into the module namespace rather than
        # prepended to the source, so the line numbers the validator reported
        # still match the code the model actually wrote — which matters,
        # because those line numbers are fed back to it on a retry (§8).
        namespace: dict[str, object] = {
            "SCENE_DURATION": duration_sec,
            "__name__": "lesson_scene",
        }
        exec(compile(source, "lesson_scene.py", "exec"), namespace)  # noqa: S102 — validated upstream

        scene_class = namespace.get("LessonScene")
        if not isinstance(scene_class, type) or not issubclass(scene_class, Scene):
            write_result(result_path, {"ok": False, "error": "LessonScene is not a Scene subclass"})
            return 1

        with tempconfig(
            {
                "pixel_width": width,
                "pixel_height": height,
                "frame_rate": fps,
                # Our own content-hash cache sits a layer above this
                # (RenderedScene), so Manim's partial-movie cache would only
                # duplicate it — and it writes into the media dir, which is a
                # per-job temp directory that is deleted straight afterwards.
                "disable_caching": True,
                "verbosity": "ERROR",
                "progress_bar": "none",
                "media_dir": str(config.media_dir),
                "output_file": "scene",
                "format": "mp4",
                # Transparency would force .mov/qtrle and a much larger file;
                # scenes composite over the player's own background instead.
                "transparent": False,
            }
        ):
            scene = scene_class()
            scene.render()
            produced = scene.renderer.file_writer.movie_file_path

        import shutil

        shutil.move(str(produced), out_path)
        write_result(result_path, {"ok": True, "path": out_path, "durationSec": duration_sec})
        return 0

    except BaseException as exc:  # noqa: BLE001 — a crashed scene must report, never propagate
        # The tail of the traceback is what gets fed back to the retry, so it
        # is trimmed to the part that names the actual failure rather than the
        # frames inside Manim.
        detail = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        write_result(result_path, {"ok": False, "error": detail[-2000:]})
        return 1


if __name__ == "__main__":
    sys.exit(main())
