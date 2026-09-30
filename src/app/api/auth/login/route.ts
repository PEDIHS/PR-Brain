import { json } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!process.env.PRBRAIN_ADMIN_PASSWORD || body.password !== process.env.PRBRAIN_ADMIN_PASSWORD) {
    return json({ ok: false, error: "Invalid credentials" }, { status: 401 });
  }

  const token = process.env.PRBRAIN_SESSION_TOKEN;
  if (!token) return json({ ok: false, error: "Session secret is not configured" }, { status: 500 });

  const secure = process.env.COOKIE_SECURE === "true";
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `prbrain_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1209600${secure ? "; Secure" : ""}`,
      "Cache-Control": "no-store",
    },
  });
}
