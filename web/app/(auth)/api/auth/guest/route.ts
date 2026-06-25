import { NextResponse } from "next/server";

// Guest access is disabled for this private, single-account deployment. Any hit here
// (e.g. a stale link) is sent to the login page.
export function GET(request: Request) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return NextResponse.redirect(new URL(`${base}/login`, request.url));
}
