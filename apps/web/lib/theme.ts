import type { Theme } from "./types";

const STORAGE_KEY = "shikkha_theme";

/**
 * Applies a theme to the document root — "LIGHT"/"DARK" set an explicit
 * `data-theme` attribute (globals.css's `:root[data-theme="..."]` blocks
 * win outright), "SYSTEM" removes the attribute so the
 * `prefers-color-scheme` media query decides instead.
 */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  if (theme === "SYSTEM") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme === "DARK" ? "dark" : "light");
  }
}

export function storeTheme(theme: Theme): void {
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private browsing / storage disabled — theme just won't persist across visits.
  }
}

export function getStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "LIGHT" || value === "DARK" || value === "SYSTEM" ? value : null;
  } catch {
    return null;
  }
}
