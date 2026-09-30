import { json } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const username = String(body.username || "").trim();
  const password = String(body.password || "");

  const expectedUsername = process.env.PRBRAIN_ADMIN_USERNAME;
  const expectedPassword = process.env.PRBRAIN_ADMIN_PASSWORD;

  if (!expectedUsername || !expectedPassword || username !== expectedUsername || password !== expectedPassword) {
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
