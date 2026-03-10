import { type NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

/**
 * Redirect unauthenticated users to the sign-in page for protected routes.
 * The /api/auth/* routes are excluded so better-auth can handle them.
 */
export async function middleware(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/sessions/:path*", "/automations/:path*", "/settings/:path*"],
};
