import { type NextRequest, NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { isDevelopmentEnvironment } from "./lib/constants";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (pathname.startsWith("/ping")) {
    return new Response("pong", { status: 200 });
  }

  // Auth endpoints and API routes enforce their own access (the route handlers return
  // 401/unauthorized) — don't redirect them, so fetches get JSON errors, not HTML.
  if (pathname.startsWith("/api")) {
    return NextResponse.next();
  }

  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  const isAuthPage =
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === `${base}/login` ||
    pathname === `${base}/register`;

  const token = await getToken({
    req: request,
    secret: process.env.AUTH_SECRET,
    secureCookie: !isDevelopmentEnvironment,
  });

  if (!token) {
    // Allow the login/register pages through; gate everything else behind login.
    if (isAuthPage) {
      return NextResponse.next();
    }
    return NextResponse.redirect(new URL(`${base}/login`, request.url));
  }

  // Logged in: keep them out of the auth pages.
  if (isAuthPage) {
    return NextResponse.redirect(new URL(`${base}/`, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/",
    "/chat/:id",
    "/api/:path*",
    "/login",
    "/register",

    "/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)",
  ],
};
