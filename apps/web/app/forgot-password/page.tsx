"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../../lib/auth-context";
import GlassCard from "../../components/GlassCard";
import { Button } from "@/components/ui/button";

export default function ForgotPasswordPage(): JSX.Element {
  const { forgotPassword } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const result = await forgotPassword(email);
      setNotice(result.message);
      // The endpoint is intentionally silent about whether the account
      // exists — always move forward to the reset form regardless.
      setTimeout(() => router.push(`/reset-password?email=${encodeURIComponent(email)}`), 1200);
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
        <h1 className="mb-2 text-3xl font-headline-lg text-on-surface tracking-tight">Forgot your password?</h1>
        <p className="mb-6 text-sm text-on-surface-variant font-label-md">
          Enter your account email and we&apos;ll send a 6-digit reset code.
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

          {notice && <p className="text-sm text-primary">{notice}</p>}

          <Button type="submit" disabled={submitting} className="w-full rounded-full px-8 py-6 text-[15px] font-label-lg bg-gradient-to-r from-primary to-tertiary hover:shadow-[0_4px_20px_rgba(0,104,95,0.3)] transition-all hover:-translate-y-0.5">
            {submitting ? "Sending…" : "Send reset code"}
          </Button>
        </form>

        <p className="mt-4 text-sm text-on-surface-variant font-label-md">
          <Link href="/login" className="text-primary font-bold hover:underline">
            Back to log in
          </Link>
        </p>
      </GlassCard>
    </main>
    </>
  );
}
