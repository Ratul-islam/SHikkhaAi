"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { GraduationCap, Sparkles, BookOpen, BrainCircuit, ArrowRight, Target } from "lucide-react";
import { useAuth } from "../lib/auth-context";

export default function HomePage(): JSX.Element {
  const { user, loading } = useAuth();

  return (
    <>
      {/* Animated Spatial Background */}
      <div className="fixed inset-0 pointer-events-none overflow-hidden z-0 bg-background/50">
        <motion.div 
          animate={{ x: [0, -60, 0], y: [0, 40, 0], scale: [1, 1.1, 1] }} 
          transition={{ duration: 18, repeat: Infinity, ease: "linear" }}
          className="absolute top-[10%] left-[10%] w-[35vw] h-[35vw] rounded-full bg-primary/15 blur-[120px]" 
        />
        <motion.div 
          animate={{ x: [0, 50, 0], y: [0, -60, 0], scale: [1, 1.2, 1] }} 
          transition={{ duration: 22, repeat: Infinity, ease: "linear" }}
          className="absolute bottom-[10%] right-[10%] w-[40vw] h-[40vw] rounded-full bg-tertiary/15 blur-[120px]" 
        />
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at center, currentColor 1px, transparent 1px)", backgroundSize: "24px 24px" }} />
      </div>

    <main className="relative z-10 flex flex-col min-h-[calc(100dvh-104px)] max-w-[1400px] mx-auto px-4 lg:px-6 mb-6">
      {/* Hero Section - Floating Island */}
      <section className="relative flex-1 flex items-center justify-center p-8 sm:p-12 lg:p-16 overflow-hidden bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] rounded-[2.5rem] mt-4 mb-6">

        <div className="relative max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">
          
          <div className="flex flex-col items-start gap-6 text-left max-w-2xl">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-surface-container-lowest/80 backdrop-blur-md shadow-sm border border-outline-variant/30 text-primary font-label-md hover:shadow-md transition-shadow">
              <Sparkles className="w-4 h-4" />
              <span>Smarter Learning for NCTB Curriculum</span>
            </div>
            
            <h1 className="text-display-hero text-on-surface tracking-tight">
              Master your studies with <span className="text-primary">Shikkha</span> AI
            </h1>
            
            <p className="text-headline-sm text-on-surface-variant font-normal leading-relaxed">
              Adaptive, gamified AI tutoring tailored specifically for the Bangladeshi NCTB curriculum — Classes 1 through 12.
            </p>

            {!loading && (
              <div className="mt-4 flex flex-col sm:flex-row gap-4 w-full sm:w-auto">
                {user ? (
                  <Link 
                    href="/roadmap"
                    className="px-8 py-3.5 rounded-full bg-gradient-to-r from-primary to-tertiary text-on-primary hover:shadow-[0_8px_24px_rgba(0,104,95,0.35)] font-label-lg transition-all hover:-translate-y-0.5 active:scale-95 flex items-center justify-center gap-2"
                  >
                    Go to your roadmap <ArrowRight className="w-4 h-4" />
                  </Link>
                ) : (
                  <>
                    <Link 
                      href="/login"
                      className="px-8 py-3.5 rounded-full bg-gradient-to-r from-primary to-tertiary text-on-primary hover:shadow-[0_8px_24px_rgba(0,104,95,0.35)] font-label-lg transition-all hover:-translate-y-0.5 active:scale-95 flex items-center justify-center gap-2"
                    >
                      Start Learning <ArrowRight className="w-4 h-4" />
                    </Link>
                    <Link 
                      href="/register"
                      className="px-8 py-3.5 rounded-full bg-surface-container-lowest/50 backdrop-blur-md hover:bg-surface-container-lowest text-on-surface font-label-lg transition-all flex items-center justify-center border border-outline-variant/30 shadow-sm hover:shadow-md hover:-translate-y-0.5"
                    >
                      Create Account
                    </Link>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="relative flex justify-center lg:justify-end">
            <div className="relative w-72 h-72 sm:w-96 sm:h-96">
              <div className="absolute inset-0 rounded-full border border-primary-fixed-dim/30 animate-[spin_10s_linear_infinite]" />
              <div className="absolute inset-4 rounded-full border border-tertiary-fixed-dim/20 animate-[spin_15s_linear_infinite_reverse]" />
              
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative">
                  <div className="absolute inset-0 rounded-full bg-primary/20 animate-ping duration-1000" />
                  <div className="absolute -inset-4 rounded-full bg-primary-fixed/40 blur-lg" />
                  <div className="relative w-32 h-32 sm:w-40 sm:h-40 rounded-full bg-primary-container text-on-primary flex items-center justify-center shadow-[0_12px_30px_rgba(0,131,120,0.3)] z-10">
                    <GraduationCap className="w-16 h-16 sm:w-20 sm:h-20" />
                  </div>
                </div>
              </div>

              {/* Floating badges */}
              <div className="absolute top-10 right-0 px-4 py-2 rounded-xl bg-surface-container-lowest shadow-lg border border-outline-variant/20 flex items-center gap-2 animate-bounce hover:scale-105 transition-transform" style={{ animationDuration: '3s' }}>
                <Target className="w-5 h-5 text-coral" />
                <span className="font-label-md text-on-surface">Adaptive Paths</span>
              </div>
              <div className="absolute bottom-16 -left-4 px-4 py-2 rounded-xl bg-surface-container-lowest shadow-lg border border-outline-variant/20 flex items-center gap-2 animate-bounce hover:scale-105 transition-transform" style={{ animationDuration: '4s', animationDelay: '1s' }}>
                <BrainCircuit className="w-5 h-5 text-tertiary" />
                <span className="font-label-md text-on-surface">AI Powered</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features Grid - Also floating islands */}
      <section className="pb-8">
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="p-8 rounded-[2rem] bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] flex flex-col gap-4 transition-all hover:-translate-y-2 hover:shadow-[0_24px_48px_rgba(0,0,0,0.12)]">
              <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center text-primary">
                <BookOpen className="w-6 h-6" />
              </div>
              <h3 className="text-headline-sm text-on-surface">NCTB Aligned</h3>
              <p className="text-body-md text-on-surface-variant">
                Curriculum completely tailored to Classes 1-12, covering textbooks and standard exercises perfectly.
              </p>
            </div>
            
            <div className="p-8 rounded-[2rem] bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] flex flex-col gap-4 transition-all hover:-translate-y-2 hover:shadow-[0_24px_48px_rgba(0,0,0,0.12)]">
              <div className="w-12 h-12 rounded-2xl bg-tertiary/10 flex items-center justify-center text-tertiary">
                <BrainCircuit className="w-6 h-6" />
              </div>
              <h3 className="text-headline-sm text-on-surface">Smart AI Tutor</h3>
              <p className="text-body-md text-on-surface-variant">
                Get step-by-step guidance on complex math and science problems without just giving away the answers.
              </p>
            </div>

            <div className="p-8 rounded-[2rem] bg-surface-container-lowest/60 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.08)] flex flex-col gap-4 transition-all hover:-translate-y-2 hover:shadow-[0_24px_48px_rgba(0,0,0,0.12)]">
              <div className="w-12 h-12 rounded-2xl bg-amber/10 flex items-center justify-center text-amber">
                <Target className="w-6 h-6" />
              </div>
              <h3 className="text-headline-sm text-on-surface">Gamified Mastery</h3>
              <p className="text-body-md text-on-surface-variant">
                Earn XP, build streaks, and unlock new levels as you master subjects and complete your roadmap.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
    </>
  );
}
