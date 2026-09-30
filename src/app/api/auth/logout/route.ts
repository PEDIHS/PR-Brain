export async function POST() {
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": "prbrain_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
      "Cache-Control": "no-store",
    },
  });
}
