import crypto from "node:crypto";

/**
 * Deterministic default avatar for a password signup (an OAuth signup uses
 * the provider's own picture instead — see oauth.routes.ts). Generated as
 * an inline SVG data URI rather than fetched from a third-party avatar
 * service: no network dependency, no external service to go down or leak
 * a request to, and "regenerate" (profile.service.ts) just picks a new
 * seed rather than re-fetching anything.
 */
const PALETTE = [
  "#0F6B4C", // primary green
  "#E8A33D", // amber
  "#C4573B", // coral
  "#3E6B8A", // steel blue
  "#8A5B9A", // plum
  "#5B8A5B", // sage
] as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1]![0] ?? "" : "";
  return (first + second).toUpperCase();
}

/** Seed can be anything stable per-user — userId for "regenerate" (a fresh look), or email at registration. */
export function generateDefaultAvatar(seed: string, name: string): string {
  const hash = crypto.createHash("sha256").update(seed).digest();
  const color = PALETTE[hash[0]! % PALETTE.length];
  const initials = initialsOf(name);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
    <rect width="128" height="128" rx="64" fill="${color}" />
    <text x="64" y="80" font-family="system-ui, sans-serif" font-size="52" font-weight="700" fill="#F6F5F1" text-anchor="middle">${initials}</text>
  </svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}
