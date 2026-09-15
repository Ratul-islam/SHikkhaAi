import { NextResponse, type NextRequest } from "next/server";

const REFRESH_COOKIE_NAME = "shikkha_refresh_token";
const ROLE_COOKIE_NAME = "shikkha_role";
const AUTH_PAGES = ["/login", "/register"];

export const config = {
  matcher: ["/admin/:path*", "/chat/:path*", "/roadmap/:path*", "/settings/:path*", "/login", "/register"],
};

// Route protection only — the actual security boundary is the backend's
// authenticate/requireAdmin preHandlers. This just redirects unauthenticated
// or non-admin users away from pages they can't use, for UX.
export function middleware(request: NextRequest): NextResponse {
  const hasSession = Boolean(request.cookies.get(REFRESH_COOKIE_NAME)?.value);
  const isAuthPage = AUTH_PAGES.includes(request.nextUrl.pathname);

  // Already logged in: bounce away from /login and /register instead of
  // showing them a form for a session they already have.
  if (hasSession && isAuthPage) {
    return NextResponse.redirect(new URL("/roadmap", request.url));
  }

  if (isAuthPage) {
    return NextResponse.next();
  }

  if (!hasSession) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (request.nextUrl.pathname.startsWith("/admin")) {
    const role = request.cookies.get(ROLE_COOKIE_NAME)?.value;
    if (role !== "ADMIN") {
      return NextResponse.redirect(new URL("/", request.url));
    }
  }

  return NextResponse.next();
}
