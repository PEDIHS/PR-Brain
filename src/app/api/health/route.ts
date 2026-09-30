import { query } from "@/lib/db";
import { json } from "@/lib/utils";
export async function GET() {
  try {
    await query("SELECT 1");
    return json({ ok: true, service: "pr-brain", time: new Date().toISOString() });
  } catch {
    return json({ ok: false }, { status: 503 });
  }
}
