"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { isAxiosError } from "axios";
import { useAuth } from "../../lib/auth-context";
import GlassCard from "../../components/GlassCard";
import { Button } from "@/components/ui/button";

function VerifyEmailForm(): JSX.Element {
  const { verifyEmail, resendVerification, user } = useAuth();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState(searchParams.get("email") ?? user?.email ?? "");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setSubmitting(true);
    try {
      await verifyEmail(email, code);
      router.push("/roadmap");
    } catch (err) {
      const message = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(message ?? "Verification failed. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend(): Promise<void> {
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const result = await resendVerification(email);
      setNotice(result.message);
    } catch {
      setError("Couldn't resend the code. Please try again in a moment.");
    } finally {
      setResending(false);
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
        <h1 className="mb-2 text-3xl font-headline-lg text-on-surface tracking-tight">Verify your email</h1>
        <p className="mb-6 text-sm text-on-surface-variant font-label-md">
          We sent a 6-digit code to your email address. Enter it below to unlock chat and mastery checks.
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

          {error && <p className="text-sm text-destructive">{error}</p>}
          {notice && <p className="text-sm text-primary">{notice}</p>}

          <Button type="submit" disabled={submitting || code.length !== 6} className="w-full">
            {submitting ? "Verifying…" : "Verify email"}
          </Button>
        </form>

        <button
          type="button"
          onClick={handleResend}
          disabled={resending || !email}
          className="mt-4 w-full text-center text-sm text-primary font-bold hover:underline disabled:opacity-50"
        >
          {resending ? "Sending…" : "Resend code"}
        </button>

        <p className="mt-4 text-sm text-on-surface-variant font-label-md">
          <Link href="/roadmap" className="text-primary font-bold hover:underline">
            Skip for now
          </Link>{" "}
          — you can browse, but chat and mastery checks need a verified email.
        </p>
      </GlassCard>
    </main>
    </>
  );
}

export default function VerifyEmailPage(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <VerifyEmailForm />
    </Suspense>
  );
}
