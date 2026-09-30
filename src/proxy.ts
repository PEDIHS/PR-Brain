import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (
    path === "/login" ||
    path.startsWith("/api/auth/") ||
    path === "/api/health" ||
    path.startsWith("/_next/") ||
    path === "/favicon.ico"
  ) return NextResponse.next();

  const expected = process.env.PRBRAIN_SESSION_TOKEN;
  const actual = request.cookies.get("prbrain_session")?.value;
  if (expected && actual === expected) return NextResponse.next();

  if (path.startsWith("/api/")) {
    return NextResponse.json({ error:"Unauthorized" },{status:401});
  }
  return NextResponse.redirect(new URL("/login",request.url));
}

export const config = {
  matcher:["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
