"use client";

import { useLayoutEffect } from "react";
import { applyTheme, getStoredTheme } from "../lib/theme";

/**
 * Applies whatever theme was last saved to localStorage, as early as
 * possible (useLayoutEffect runs before the browser paints) so returning
 * visitors don't see a flash of the wrong theme. The authoritative value
 * lives server-side on UserSettings — this is just the fast local cache;
 * `app/settings/page.tsx` re-applies and re-stores it from the server on
 * load, so a theme changed on another device still wins once this one logs in.
 */
export default function ThemeInit(): null {
  useLayoutEffect(() => {
    const stored = getStoredTheme();
    if (stored) applyTheme(stored);
  }, []);

  return null;
}
