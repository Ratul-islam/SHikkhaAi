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


# Encoder settings for each animation's partial movie. Manim's own are
# `crf=23` with x264's defaults for everything else — which means a 40-frame
# lookahead and one set of buffers per CPU core. Measured on a 15s Bangla +
# LaTeX scene (process-tree peak, PSNR against a lossless encode):
#
#                        720p30                     480p15
#   manim default        364MB  55.68dB  186KB      318MB  56.06dB  79KB
#   these settings       267MB  56.48dB  121KB      223MB  57.08dB  63KB
#
# So less memory, smaller files AND higher fidelity. The trade that makes it
# work: a shorter lookahead alone costs ~2dB, and the lower CRF buys it back
# and then some. `preset=veryfast` was measured too and REJECTED — it saves the
# same memory but loses ~2.7dB, and lesson quality is not what this is for.
X264_OPTIONS = {
    "crf": "20",
    "threads": "2",
    "x264-params": "rc-lookahead=10",
}

# Manim encodes on a worker thread fed by a queue that is UNBOUNDED when one
# encoder runs (its default). Frames are drawn faster than x264 compresses
# them, so raw RGBA frames — 3.7MB each at 720p — pile up: a 720p text scene
# peaked at 610MB that way. A few frames of slack is all the thread needs.
ENCODER_QUEUE_FRAMES = 4


def apply_low_memory_encoding() -> None:
    """Bounds Manim's frame queue and sets the x264 options above.

    Reaches into two Manim internals, which is why it is wrapped: manim is
    pinned in manim-requirements.txt, but if an upgrade renames either one the
    render must still happen — just with Manim's own (heavier) settings — so a
    mismatch is reported on stderr and otherwise ignored. This is OUR runner
    code, applied before the model's scene is executed; the model's source
    can't see or reach any of it (validate.py forbids the imports).
    """
    try:
        import threading

        import manim.scene.scene_file_writer as writer_module

        job_class = writer_module._PartialMovieEncodeJob
        writer_class = writer_module.SceneFileWriter
        real_av = writer_module.av
        opening_partial = threading.local()

        original_job_init = job_class.__init__

        def bounded_job_init(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            if kwargs.get("frame_queue_size") == 0:
                kwargs["frame_queue_size"] = ENCODER_QUEUE_FRAMES
            original_job_init(self, *args, **kwargs)

        class ContainerWithOptions:
            """Adds X264_OPTIONS to the one add_stream call a partial movie makes."""

            def __init__(self, container):  # type: ignore[no-untyped-def]
                self._container = container

            def __getattr__(self, name):  # type: ignore[no-untyped-def]
                return getattr(self._container, name)

            def add_stream(self, codec_name, *args, options=None, **kwargs):  # type: ignore[no-untyped-def]
                if codec_name == "libx264":
                    options = {**(options or {}), **X264_OPTIONS}
                return self._container.add_stream(codec_name, *args, options=options, **kwargs)

        class AvForPartialMovies:
            """`av` as scene_file_writer sees it — identical, except while a partial movie is being opened."""

            def __getattr__(self, name):  # type: ignore[no-untyped-def]
                return getattr(real_av, name)

            def open(self, *args, **kwargs):  # type: ignore[no-untyped-def]
                container = real_av.open(*args, **kwargs)
                if getattr(opening_partial, "active", False) and kwargs.get("mode") == "w":
                    return ContainerWithOptions(container)
                return container

        original_open_partial = writer_class.open_partial_movie_stream

        def open_partial_with_options(self, *args, **kwargs):  # type: ignore[no-untyped-def]
            opening_partial.active = True
            try:
                return original_open_partial(self, *args, **kwargs)
            finally:
                opening_partial.active = False

        job_class.__init__ = bounded_job_init
        writer_module.av = AvForPartialMovies()
        writer_class.open_partial_movie_stream = open_partial_with_options
    except Exception as exc:  # noqa: BLE001 — degrade to Manim's defaults, never fail the render
        sys.stderr.write(f"low-memory encoding not applied: {exc!r}\n")


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

        apply_low_memory_encoding()

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
