"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../../../lib/auth-context";
import GlassCard from "../../../components/GlassCard";

/**
 * Landed on after oauth.routes.ts's Google callback sets the refresh-token
 * cookie and redirects here. There's no access token in this URL by design
 * (see oauth.routes.ts's comment) — AuthProvider's own mount effect already
 * calls refreshSession() against that cookie on every page load, so this
 * page just waits for it and forwards the result.
 */
export default function OAuthCallbackPage(): JSX.Element {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    router.replace(user ? "/roadmap" : "/login?error=oauth_failed");
  }, [loading, user, router]);

  return (
    <main className="mx-auto flex min-h-[calc(100vh-65px)] max-w-md flex-col justify-center px-6">
      <GlassCard className="p-8 text-center">
        <p className="text-sm text-foreground/60">Signing you in…</p>
      </GlassCard>
    </main>
  );
}
