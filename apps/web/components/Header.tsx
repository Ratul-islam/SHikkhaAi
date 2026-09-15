"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Flame, Sparkles, LogOut, ChevronDown, Menu, X } from "lucide-react";
import { useAuth } from "../lib/auth-context";
import AnimatedCounter from "./AnimatedCounter";

export default function Header(): JSX.Element {
  const { user, loading, logout } = useAuth();
  const prevStreak = useRef<number | null>(null);
  const [streakBumped, setStreakBumped] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isProfileDropdownOpen, setIsProfileDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (!user) return;
    if (prevStreak.current !== null && user.streakDays > prevStreak.current) {
      setStreakBumped(true);
      const t = setTimeout(() => setStreakBumped(false), 700);
      return () => clearTimeout(t);
    }
    prevStreak.current = user.streakDays;
  }, [user]);

  // Close mobile menu when route changes
  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsProfileDropdownOpen(false);
  }, [pathname]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProfileDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const navLinks = [
    { name: "Home", path: "/" },
    { name: "Roadmap", path: "/roadmap" },
    { name: "AI Tutor", path: "/chat" }
  ];

  return (
    <>
      <div className="sticky top-4 z-50 w-full px-4 flex justify-center pointer-events-none mb-6">
        <header className="pointer-events-auto w-full max-w-5xl rounded-full bg-surface-container-lowest/60 backdrop-blur-xl border border-outline-variant/30 shadow-[0_8px_32px_rgba(0,0,0,0.08)] transition-all duration-300 hover:bg-surface-container-lowest/80 hover:shadow-[0_8px_32px_rgba(0,0,0,0.12)]">
          <div className="h-14 px-4 md:px-6 flex items-center justify-between gap-2 md:gap-4">
          
          <div className="flex items-center gap-3 md:gap-6 shrink-0">
            {user && (
              <button 
                className="xl:hidden p-1.5 -ml-1 text-on-surface-variant hover:text-on-surface transition-colors rounded-full hover:bg-surface-container"
                onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
                aria-label="Toggle mobile menu"
              >
                {isMobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
              </button>
            )}

            <Link href="/" className="flex items-center gap-2 group">
              <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-on-primary font-bold text-lg shadow-[0_0_12px_rgba(0,104,95,0.3)] group-hover:scale-105 transition-transform duration-300 shrink-0">S</div>
              <div className="flex flex-col hidden sm:flex">
                <span className="font-headline-sm tracking-tight bg-gradient-to-r from-primary to-tertiary bg-clip-text text-transparent">Shikkha</span>
                <span className="font-label-sm text-on-surface-variant -mt-1 opacity-70 group-hover:opacity-100 transition-opacity">AI Platform</span>
              </div>
            </Link>

            {user && (
              <nav className="hidden xl:flex items-center gap-1 p-1 bg-surface-container-lowest/50 border border-outline-variant/20 rounded-full">
                {navLinks.map((link) => {
                  const isActive = pathname === link.path;
                  return (
                    <Link 
                      key={link.path}
                      href={link.path} 
                      className={`px-4 py-1.5 rounded-full font-label-md transition-all duration-200 ${isActive ? 'bg-primary text-on-primary shadow-[0_2px_8px_rgba(0,104,95,0.25)]' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/50'}`}
                    >
                      {link.name}
                    </Link>
                  );
                })}
                {user.role === "ADMIN" && (
                  <Link 
                    href="/admin" 
                    className={`px-4 py-1.5 rounded-full font-label-md transition-all duration-200 ${pathname.startsWith('/admin') ? 'bg-primary text-on-primary shadow-[0_2px_8px_rgba(0,104,95,0.25)]' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high/50'}`}
                  >
                    Admin
                  </Link>
                )}
              </nav>
            )}
          </div>

          <div className="flex items-center gap-2 md:gap-3 shrink-0">
            {user ? (
              <>
                <div className="hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-high text-on-surface font-label-md shadow-[0_1px_4px_rgba(15,23,42,0.02)]">
                  <AnimatePresence>
                    <motion.span
                      key={streakBumped ? "bumped" : "steady"}
                      animate={streakBumped ? { scale: [1, 1.35, 1] } : { scale: 1 }}
                      transition={{ duration: 0.5 }}
                      className="flex items-center text-coral text-base leading-none"
                      title="Daily streak"
                    >
                      <Flame className="w-4 h-4 fill-current mr-1" />
                      {user.streakDays} days
                    </motion.span>
                  </AnimatePresence>
                </div>

                <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-secondary-fixed text-on-secondary-fixed font-label-md shadow-[0_1px_4px_rgba(15,23,42,0.02)]">
                  <Sparkles className="w-4 h-4 text-secondary-fixed-dim" />
                  <AnimatedCounter value={user.xp} /> XP
                </div>

                <button className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-low hover:bg-surface-container text-on-surface font-label-md transition-colors">
                  <span>Class {user.classLevel}</span>
                  <ChevronDown className="w-4 h-4 text-on-surface-variant" />
                </button>

                <div className="relative pl-1 flex items-center gap-2" ref={dropdownRef}>
                  <button 
                    onClick={() => setIsProfileDropdownOpen(!isProfileDropdownOpen)} 
                    className="flex items-center justify-center p-0.5 rounded-full ring-2 ring-primary-fixed hover:ring-primary transition-all relative"
                  >
                    {user.avatarUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={user.avatarUrl} alt="" className="w-8 h-8 rounded-full object-cover" />
                    ) : (
                      <div className="flex w-8 h-8 items-center justify-center rounded-full bg-surface-container-high text-xs text-on-surface-variant">
                        ?
                      </div>
                    )}
                  </button>

                  <AnimatePresence>
                    {isProfileDropdownOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 10, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 10, scale: 0.95 }}
                        transition={{ duration: 0.2 }}
                        className="absolute top-[120%] right-0 mt-2 w-48 rounded-[1.5rem] bg-surface-container-lowest/90 backdrop-blur-3xl border border-outline-variant/30 shadow-[0_16px_40px_rgba(0,0,0,0.12)] p-2 z-50 flex flex-col gap-1"
                      >
                        <Link 
                          href="/settings"
                          onClick={() => setIsProfileDropdownOpen(false)}
                          className="flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-label-md text-on-surface hover:bg-surface-container-low transition-colors"
                        >
                          <div className="w-5 h-5 rounded-full bg-primary/10 flex items-center justify-center text-primary">
                            <span className="text-[10px] font-bold">P</span>
                          </div>
                          Profile Settings
                        </Link>
                        <div className="h-px w-full bg-outline-variant/20 my-1" />
                        <button 
                          onClick={() => { setIsProfileDropdownOpen(false); logout(); }} 
                          className="flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-label-md text-error hover:bg-error/10 transition-colors w-full text-left"
                        >
                          <LogOut className="w-4 h-4" />
                          Log out
                        </button>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </>
            ) : !loading && (
              <Link 
                href="/login"
                className="px-4 md:px-5 py-1.5 md:py-2 rounded-full bg-primary text-on-primary hover:bg-primary-container font-label-md transition-all duration-300 shadow-[0_4px_12px_rgba(0,104,95,0.2)] hover:shadow-[0_4px_16px_rgba(0,104,95,0.4)] hover:-translate-y-0.5 whitespace-nowrap"
              >
                Log in
              </Link>
            )}
          </div>
          
          </div>
        </header>
      </div>

      <AnimatePresence>
        {isMobileMenuOpen && user && (
          <motion.div
            initial={{ x: '-100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '-100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed inset-0 z-40 bg-surface-container-lowest/95 backdrop-blur-3xl xl:hidden flex flex-col justify-center items-center p-6"
          >
            <nav className="flex flex-col items-center justify-center gap-8 w-full">
              {navLinks.map((link) => {
                const isActive = pathname === link.path;
                return (
                  <Link
                    key={link.path}
                    href={link.path}
                    onClick={() => setIsMobileMenuOpen(false)}
                    className={`text-3xl font-headline-lg transition-all duration-300 ${isActive ? 'text-primary scale-110' : 'text-on-surface-variant hover:text-on-surface hover:scale-105'}`}
                  >
                    {link.name}
                  </Link>
                );
              })}
              {user.role === "ADMIN" && (
                <Link
                  href="/admin"
                  onClick={() => setIsMobileMenuOpen(false)}
                  className={`text-3xl font-headline-lg transition-all duration-300 ${pathname.startsWith('/admin') ? 'text-primary scale-110' : 'text-on-surface-variant hover:text-on-surface hover:scale-105'}`}
                >
                  Admin
                </Link>
              )}
              
              <div className="mt-10 flex flex-col items-center gap-4 w-full max-w-[280px]">
                <div className="flex sm:hidden items-center justify-center gap-3 w-full py-4 rounded-2xl bg-surface-container-high text-on-surface font-label-lg shadow-sm">
                  <Flame className="w-6 h-6 text-coral" /> 
                  <span className="text-lg">{user.streakDays} days</span>
                </div>
                <div className="flex md:hidden items-center justify-center gap-3 w-full py-4 rounded-2xl bg-secondary-fixed text-on-secondary-fixed font-label-lg shadow-sm">
                  <Sparkles className="w-6 h-6 text-secondary-fixed-dim" /> 
                  <span className="text-lg"><AnimatedCounter value={user.xp} /> XP</span>
                </div>
                <div className="flex lg:hidden items-center justify-center gap-3 w-full py-4 rounded-2xl bg-surface-container-low text-on-surface font-label-lg shadow-sm">
                  <span className="text-lg">Class {user.classLevel}</span>
                </div>
                <button 
                  onClick={() => { setIsMobileMenuOpen(false); logout(); }} 
                  className="flex sm:hidden items-center justify-center gap-3 w-full py-4 rounded-2xl bg-error/10 text-error font-label-lg mt-4 hover:bg-error/20 transition-colors"
                >
                  <LogOut className="w-6 h-6" /> 
                  <span className="text-lg">Log out</span>
                </button>
              </div>
            </nav>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

