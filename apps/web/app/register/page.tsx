"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { isAxiosError } from "axios";
import { useAuth } from "../../lib/auth-context";
import GlassCard from "../../components/GlassCard";
import GoogleSignInButton from "../../components/GoogleSignInButton";
import { Button } from "@/components/ui/button";

export default function RegisterPage(): JSX.Element {
  const { register } = useAuth();
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [classLevel, setClassLevel] = useState(9);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await register({ name, email, password, classLevel });
      // The account can browse unverified (backend gates chat/mastery, not
      // login), but nudging straight to verification means they see the
      // roadmap fully unlocked the first time they land there.
      router.push(`/verify-email?email=${encodeURIComponent(email)}`);
    } catch (err) {
      const message = isAxiosError(err) ? (err.response?.data?.error as string | undefined) : undefined;
      setError(message ?? "Registration failed. Please try again.");
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
        <h1 className="mb-6 text-3xl font-headline-lg text-on-surface tracking-tight">Create your ShikkhaAI account</h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
            Name
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
            />
          </label>

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
            Password
            <input
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm font-label-lg text-on-surface-variant ml-1 mb-1">
            Class level
            <select
              value={classLevel}
              onChange={(e) => setClassLevel(Number(e.target.value))}
              className="w-full rounded-2xl bg-surface-container-lowest/50 backdrop-blur-sm border border-outline-variant/30 px-4 py-3 text-[15px] outline-none transition-all focus:border-primary/50 focus:ring-4 focus:ring-primary/10 hover:bg-surface-container-lowest/80"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((level) => (
                <option key={level} value={level}>
                  Class {level}
                </option>
              ))}
            </select>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={submitting} className="w-full rounded-full px-8 py-6 text-[15px] font-label-lg bg-gradient-to-r from-primary to-tertiary hover:shadow-[0_4px_20px_rgba(0,104,95,0.3)] transition-all hover:-translate-y-0.5">
            {submitting ? "Creating account…" : "Register"}
          </Button>
        </form>

        <GoogleSignInButton />
        
        <p className="mt-4 text-sm text-on-surface-variant font-label-md">
          Already have an account?{" "}
          <Link href="/login" className="text-primary font-bold hover:underline">
            Log in
          </Link>
        </p>
      </GlassCard>
    </main>
    </>
  );
}
