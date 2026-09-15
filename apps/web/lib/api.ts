import axios, { AxiosError, type InternalAxiosRequestConfig } from "axios";
import type { AuthTokenResponse } from "./types";

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retry?: boolean;
}

let accessToken: string | null = null;
let onAuthFailure: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** Called when a request fails auth even after a refresh attempt — used by AuthProvider to clear state/redirect. */
export function setOnAuthFailure(cb: (() => void) | null): void {
  onAuthFailure = cb;
}

const AUTH_PATHS_EXEMPT_FROM_REFRESH = ["/auth/login", "/auth/register", "/auth/refresh"];

export const api = axios.create({
  baseURL: "/api/v1",
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  if (accessToken) {
    config.headers.set("Authorization", `Bearer ${accessToken}`);
  }
  return config;
});

// Module-level singleton so concurrent callers (the response interceptor,
// AuthProvider's mount effect, and — in dev — React 18 Strict Mode's
// double-invoked effects) share one in-flight request instead of each
// sending their own. The refresh token is single-use/rotating, so two
// concurrent refresh calls would otherwise race: the second arrives after
// the first has already revoked+replaced the cookie server-side and gets
// a spurious 401.
let refreshPromise: Promise<AuthTokenResponse | null> | null = null;

/** Calls POST /auth/refresh at most once per in-flight batch; safe to call from multiple places concurrently. */
export function refreshSession(): Promise<AuthTokenResponse | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        // {} rather than null/undefined — some browsers send a non-JSON
        // Content-Type for an empty body, which Fastify's JSON parser 415s on.
        const response = await axios.post<AuthTokenResponse>("/api/v1/auth/refresh", {}, {
          withCredentials: true,
        });
        setAccessToken(response.data.accessToken);
        return response.data;
      } catch {
        setAccessToken(null);
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as RetryableConfig | undefined;
    const isExempt = AUTH_PATHS_EXEMPT_FROM_REFRESH.some((path) => originalRequest?.url?.includes(path));

    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isExempt) {
      originalRequest._retry = true;

      const session = await refreshSession();
      if (session) {
        originalRequest.headers.set("Authorization", `Bearer ${session.accessToken}`);
        return api(originalRequest);
      }

      onAuthFailure?.();
    }

    return Promise.reject(error);
  },
);
