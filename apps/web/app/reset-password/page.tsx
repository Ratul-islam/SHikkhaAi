"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { isAxiosError } from "axios";
import { useAuth } from "../../lib/auth-context";
import GlassCard from "../../components/GlassCard";
import { Button } from "@/components/ui/button";

function ResetPasswordForm(): JSX.Element {
  const { resetPassword } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") ?? "");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      // Resetting revokes every existing session server-side, so the user
      // has to log back in with the new password — there's no session left
      // to carry them forward automatically.
      await resetPassword(email, code, newPassword);
      router.push("/login");
    } catch (err) {
      const message = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(message ?? "Couldn't reset your password. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
        <>
      {/* Animated Spatial Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0 bg-background/50">
        <div 
          className="absolute top-[10%] left-[10%] w-[40vw] h-[40vw] rounded-full bg-primary/15 blur-[120px] animate-pulse" 
          style={{ animationDuration: "8s" }}
        />
        <div 
          className="absolute bottom-[10%] right-[10%] w-[45vw] h-[45vw] rounded-full bg-tertiary/15 blur-[120px] animate-pulse" 
          style={{ animationDuration: "12s", animationDelay: "2s" }}
        />
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at center, currentColor 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      </div>
      <main className="relative z-10 mx-auto flex min-h-[calc(100vh-65px)] max-w-md flex-col justify-center px-6">
      <GlassCard className="p-8">
        <h1 className="mb-2 text-3xl font-headline-lg text-on-surface tracking-tight">Reset your password</h1>
        <p className="mb-6 text-sm text-on-surface-variant font-label-md">
          Enter the 6-digit code we emailed you along with your new password.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
            Email
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
            6-digit code
            <input
              required
              inputMode="numeric"
              minLength={6}
              maxLength={6}
              pattern="[0-9]{6}"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="rounded-lg border border-input bg-card/70 px-3 py-2 text-center text-lg tracking-[0.5em] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
            New password
            <input
              type="password"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting || code.length !== 6} className="w-full">
            {submitting ? "Resetting…" : "Reset password"}
          </Button>
        </form>

        <p className="mt-4 text-sm text-on-surface-variant font-label-md">
          <Link href="/forgot-password" className="text-primary font-bold hover:underline">
            Request a new code
          </Link>
        </p>
      </GlassCard>
    </main>
    </>
  );
}

export default function ResetPasswordPage(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ResetPasswordForm />
    </Suspense>
  );
}
