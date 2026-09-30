import { query } from "@/lib/db";
import { json } from "@/lib/utils";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const projectId = url.searchParams.get("projectId");
  if (!q || !projectId) return json({ results: [] });
  const results = await query(
    `SELECT id,title,summary,node_type,current_version,updated_at,
      ts_rank(to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(content,'')),
      plainto_tsquery('simple',$2)) rank
     FROM knowledge_nodes
     WHERE project_id=$1 AND (
       to_tsvector('simple',coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(content,'')) @@ plainto_tsquery('simple',$2)
       OR title ILIKE '%' || $2 || '%' OR summary ILIKE '%' || $2 || '%' OR content ILIKE '%' || $2 || '%')
     ORDER BY rank DESC, updated_at DESC LIMIT 30`,
    [projectId,q],
  );
  return json({ results:results.rows });
}
