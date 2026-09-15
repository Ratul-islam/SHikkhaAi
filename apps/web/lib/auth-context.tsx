"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, refreshSession, setAccessToken, setOnAuthFailure } from "./api";
import type { AuthTokenResponse, AuthUser, MessageResponse, UpdateClassResponse } from "./types";

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  register: (input: { email: string; password: string; name: string; classLevel: number }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  logoutAllDevices: () => Promise<void>;
  /** Sets the verified session in place (tokens are re-issued on success) without a full page reload. */
  verifyEmail: (email: string, code: string) => Promise<AuthUser>;
  resendVerification: (email: string) => Promise<MessageResponse>;
  forgotPassword: (email: string) => Promise<MessageResponse>;
  resetPassword: (email: string, code: string, newPassword: string) => Promise<MessageResponse>;
  /** classLevel is baked into the access token (roadmap/chat default to it), so this re-issues one — same pattern as verifyEmail. */
  updateClassLevel: (classLevel: number) => Promise<AuthUser>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): JSX.Element {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const clearAuth = useCallback(() => {
    setAccessToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setOnAuthFailure(() => {
      clearAuth();
      router.push("/login");
    });
    return () => setOnAuthFailure(null);
  }, [clearAuth, router]);

  // Silent refresh on mount: the HttpOnly refresh cookie may still be valid
  // even though we hold no access token in memory (e.g. page reload). Uses
  // the shared refreshSession() singleton (see lib/api.ts) rather than its
  // own request — otherwise React 18 Strict Mode's double-invoked effects
  // (dev only) would fire two concurrent refreshes against the same
  // single-use rotating token, and the second would spuriously 401.
  useEffect(() => {
    let cancelled = false;
    refreshSession().then((session) => {
      if (cancelled) return;
      if (session) {
        setUser(session.user);
      } else {
        clearAuth();
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [clearAuth]);

  const login = useCallback(async (email: string, password: string): Promise<AuthUser> => {
    const response = await api.post<AuthTokenResponse>("/auth/login", { email, password });
    setAccessToken(response.data.accessToken);
    setUser(response.data.user);
    return response.data.user;
  }, []);

  const register = useCallback(
    async (input: { email: string; password: string; name: string; classLevel: number }): Promise<AuthUser> => {
      const response = await api.post<AuthTokenResponse>("/auth/register", input);
      setAccessToken(response.data.accessToken);
      setUser(response.data.user);
      return response.data.user;
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await api.post("/auth/logout");
    } finally {
      clearAuth();
      router.push("/login");
    }
  }, [clearAuth, router]);

  const logoutAllDevices = useCallback(async (): Promise<void> => {
    try {
      await api.post("/auth/logout-all");
    } finally {
      clearAuth();
      router.push("/login");
    }
  }, [clearAuth, router]);

  // Success re-issues tokens with emailVerified: true baked into the access
  // token immediately (see auth.routes.ts) — apply it here too so the app
  // doesn't need a refresh to notice.
  const verifyEmail = useCallback(async (email: string, code: string): Promise<AuthUser> => {
    const response = await api.post<AuthTokenResponse>("/auth/verify-email", { email, code });
    setAccessToken(response.data.accessToken);
    setUser(response.data.user);
    return response.data.user;
  }, []);

  const resendVerification = useCallback(async (email: string): Promise<MessageResponse> => {
    const response = await api.post<MessageResponse>("/auth/resend-verification", { email });
    return response.data;
  }, []);

  const forgotPassword = useCallback(async (email: string): Promise<MessageResponse> => {
    const response = await api.post<MessageResponse>("/auth/forgot-password", { email });
    return response.data;
  }, []);

  const resetPassword = useCallback(
    async (email: string, code: string, newPassword: string): Promise<MessageResponse> => {
      const response = await api.post<MessageResponse>("/auth/reset-password", { email, code, newPassword });
      return response.data;
    },
    [],
  );

  const updateClassLevel = useCallback(
    async (classLevel: number): Promise<AuthUser> => {
      const response = await api.patch<UpdateClassResponse>("/profile/class", { classLevel });
      setAccessToken(response.data.accessToken);
      // Merge rather than replace — the profile response doesn't carry every
      // AuthUser field (e.g. it's the same shape either way here, but this
      // stays correct if that ever changes).
      const updated: AuthUser = { ...(user as AuthUser), ...response.data.profile };
      setUser(updated);
      return updated;
    },
    [user],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      register,
      logout,
      logoutAllDevices,
      verifyEmail,
      resendVerification,
      forgotPassword,
      resetPassword,
      updateClassLevel,
    }),
    [
      user,
      loading,
      login,
      register,
      logout,
      logoutAllDevices,
      verifyEmail,
      resendVerification,
      forgotPassword,
      resetPassword,
      updateClassLevel,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
