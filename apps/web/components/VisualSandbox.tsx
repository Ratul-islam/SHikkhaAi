"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { buildSandboxBody } from "../lib/sandboxHtml";

/**
 * Renders model-generated HTML5 Canvas/SVG/CSS teaching widgets inside a
 * sandboxed iframe. Never injected via dangerouslySetInnerHTML into the main
 * document — `sandbox="allow-scripts"` with NO `allow-same-origin` keeps the
 * generated code isolated from the app's own DOM, cookies, and storage.
 *
 * The widget can talk back over a narrow, versioned `postMessage` protocol
 * (see `shikkha` in the injected preamble below), which is what lets the tutor
 * react to what the student actually did in the diagram. That channel is the
 * one place untrusted model output reaches the app, so every message is
 * source-checked, shape-checked, length-capped, and rate-capped before it is
 * believed — and no widget string is ever rendered as HTML.
 */

/** Messages a widget is allowed to send. Anything else is dropped silently. */
export type WidgetEvent =
  | { type: "result"; correct: boolean; detail: string }
  | { type: "ask"; question: string };

const MAX_DETAIL_LENGTH = 300;
/** A runaway setInterval must not be able to flood the chat — this is the ceiling per frame. */
const MAX_EVENTS_PER_SECOND = 4;
const MIN_FRAME_HEIGHT = 220;
const MAX_FRAME_HEIGHT = 900;

/**
 * Injected into every widget so the model has a stable API to call rather than
 * hand-writing `parent.postMessage` shapes (which it gets wrong). Also installs
 * an error handler, so a widget that throws reports itself as broken instead of
 * silently rendering a blank white rectangle — the failure mode that made bad
 * widgets indistinguishable from missing ones.
 */
const SANDBOX_PREAMBLE = `
<script>
(function () {
  function post(msg) {
    try { parent.postMessage(Object.assign({ v: 1 }, msg), "*"); } catch (e) {}
  }

  // Widgets routinely call result() during their own initialization (drawing
  // the first frame, seeding a slider), and that used to fire a chat turn the
  // student never asked for — an unsolicited message and a wasted model call,
  // seen immediately on the first real end-to-end run. So result/ask are
  // inert until this document has actually seen a user gesture. height() is
  // exempt: sizing must work before anyone touches anything.
  var interacted = false;
  ["pointerdown", "keydown", "touchstart", "change", "input"].forEach(function (evt) {
    document.addEventListener(evt, function () { interacted = true; }, { capture: true, passive: true });
  });

  window.shikkha = {
    height: function (px) { post({ type: "shikkha:height", px: Number(px) || 0 }); },
    result: function (correct, detail) {
      if (!interacted) return;
      post({ type: "shikkha:result", correct: !!correct, detail: String(detail == null ? "" : detail) });
    },
    ask: function (question) {
      if (!interacted) return;
      post({ type: "shikkha:ask", question: String(question == null ? "" : question) });
    }
  };
  window.addEventListener("error", function (e) {
    post({ type: "shikkha:error", message: String((e && e.message) || "widget error") });
  });
  // Report our own height on load and on any resize, so the frame fits the
  // widget instead of forcing every widget into a fixed 16:9 box.
  function reportHeight() {
    var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
    if (h > 0) window.shikkha.height(h);
  }
  window.addEventListener("load", reportHeight);
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
})();
</script>`;

export default function VisualSandbox({
  html,
  onEvent,
  className,
}: {
  html: string;
  /** Fired for a validated `shikkha.result()` / `shikkha.ask()` call from inside the widget. */
  onEvent?: (event: WidgetEvent) => void;
  className?: string;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [resetKey, setResetKey] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [height, setHeight] = useState(360);
  const [broken, setBroken] = useState(false);

  // Rate-limiter state, deliberately in a ref: throttling must not re-render.
  const eventWindowRef = useRef<{ start: number; count: number }>({ start: 0, count: 0 });

  const srcDoc = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      html, body { margin: 0; padding: 0; background: #fff; color: #111; }
      body {
        display: flex; align-items: center; justify-content: center;
        padding: 12px; box-sizing: border-box;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      svg, canvas { max-width: 100%; height: auto; }
    </style>
    ${SANDBOX_PREAMBLE}
  </head>
  <body>
    ${buildSandboxBody(html)}
  </body>
</html>`;

  const allowEvent = useCallback((): boolean => {
    const now = Date.now();
    const w = eventWindowRef.current;
    if (now - w.start > 1000) {
      w.start = now;
      w.count = 0;
    }
    w.count += 1;
    return w.count <= MAX_EVENTS_PER_SECOND;
  }, []);

  useEffect(() => {
    function handleMessage(event: MessageEvent): void {
      // Identity comes from the source handle, not the origin: a sandbox with
      // no `allow-same-origin` reports its origin as the literal string
      // "null", which is unusable for authentication and which any other
      // sandboxed frame on the page would also report.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;

      const data = event.data as Record<string, unknown> | null;
      if (!data || typeof data !== "object" || data.v !== 1 || typeof data.type !== "string") return;

      if (data.type === "shikkha:height") {
        const px = typeof data.px === "number" && Number.isFinite(data.px) ? data.px : 0;
        if (px > 0) setHeight(Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.ceil(px))));
        return;
      }

      if (data.type === "shikkha:error") {
        setBroken(true);
        return;
      }

      if (!allowEvent()) return;

      if (data.type === "shikkha:result") {
        onEvent?.({
          type: "result",
          correct: Boolean(data.correct),
          detail: typeof data.detail === "string" ? data.detail.trim().slice(0, MAX_DETAIL_LENGTH) : "",
        });
        return;
      }

      if (data.type === "shikkha:ask") {
        const question = typeof data.question === "string" ? data.question.trim().slice(0, MAX_DETAIL_LENGTH) : "";
        if (question) onEvent?.({ type: "ask", question });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [allowEvent, onEvent]);

  // A remount is a fresh widget: clear the error state and the throttle window
  // along with it, or a reset could never recover from one bad run.
  useEffect(() => {
    setBroken(false);
    eventWindowRef.current = { start: 0, count: 0 };
  }, [resetKey, html]);

  async function toggleFullscreen(): Promise<void> {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      await containerRef.current.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  }

  return (
    <div
      ref={containerRef}
      className={`group relative overflow-hidden rounded-xl border border-outline-variant/30 bg-surface-container-lowest data-[fullscreen=true]:rounded-none ${className ?? ""}`}
      data-fullscreen={isFullscreen}
    >
      <iframe
        key={resetKey}
        ref={frameRef}
        title="ইন্টারঅ্যাক্টিভ ব্যাখ্যা"
        srcDoc={srcDoc}
        sandbox="allow-scripts"
        className="w-full border-0 data-[fullscreen=true]:h-screen"
        style={isFullscreen ? undefined : { height }}
        data-fullscreen={isFullscreen}
      />

      {broken && (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-destructive/90 px-3 py-1.5 text-xs text-destructive-foreground">
          <TriangleAlert className="size-3.5 shrink-0" />
          ভিজ্যুয়ালটি ঠিকমতো চলেনি — রিসেট করে দেখুন, বা আবার জিজ্ঞাসা করুন।
        </div>
      )}

      <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Button variant="secondary" size="icon-sm" onClick={() => setResetKey((k) => k + 1)} title="রিসেট">
          <RotateCcw className="size-3.5" />
        </Button>
        <Button variant="secondary" size="icon-sm" onClick={toggleFullscreen} title="ফুলস্ক্রিন">
          {isFullscreen ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
