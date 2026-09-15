"use client";

import { useEffect, useRef, useState } from "react";
import { animate } from "framer-motion";

/** Counts up to `value` whenever it changes; renders instantly on first mount (no count-up from 0 on page load). */
export default function AnimatedCounter({ value, className }: { value: number; className?: string }) {
  const [display, setDisplay] = useState(value);
  const mounted = useRef(false);

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      setDisplay(value);
      return;
    }
    const controls = animate(display, value, {
      duration: 0.6,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <span className={className}>{display}</span>;
}
