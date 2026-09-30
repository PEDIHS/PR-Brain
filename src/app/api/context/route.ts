import { query } from "@/lib/db";
import { json } from "@/lib/utils";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  const q = (url.searchParams.get("q") || "").trim();
  if (!projectId) return json({ error:"projectId is required" },{status:400});
  const project = (await query("SELECT id,name,slug,description,status,updated_at FROM projects WHERE id=$1",[projectId])).rows[0];
  if (!project) return json({ error:"Project not found" },{status:404});
  const [workflows, nodes, roadmap, activity] = await Promise.all([
    query("SELECT id,name,slug,description,position FROM workflows WHERE project_id=$1 ORDER BY position",[projectId]),
    q ? query(
      `SELECT id,workflow_id,parent_id,node_type,title,summary,content,status,metadata,current_version,updated_at
       FROM knowledge_nodes WHERE project_id=$1 AND (
       to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,'')) @@ plainto_tsquery('simple',$2)
       OR title ILIKE '%'||$2||'%' OR summary ILIKE '%'||$2||'%')
       ORDER BY updated_at DESC LIMIT 18`,[projectId,q]
    ) : query(
      `SELECT id,workflow_id,parent_id,node_type,title,summary,content,status,metadata,current_version,updated_at
       FROM knowledge_nodes WHERE project_id=$1 ORDER BY updated_at DESC LIMIT 18`,[projectId]
    ),
    query(`SELECT id,workflow_id,parent_id,title,description,status,priority,progress,target_date
           FROM roadmap_items WHERE project_id=$1 AND status <> 'done' ORDER BY priority,position LIMIT 20`,[projectId]),
    query(`SELECT entity_type,action,title,details,actor,created_at
           FROM activity_log WHERE project_id=$1 ORDER BY created_at DESC LIMIT 20`,[projectId]),
  ]);
  return json({ schema_version:"1.0", generated_at:new Date().toISOString(), query:q || null, project,
    workflows:workflows.rows, relevant_knowledge:nodes.rows, active_roadmap:roadmap.rows, recent_changes:activity.rows });
}
