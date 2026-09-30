import { query } from "@/lib/db";
import { json } from "@/lib/utils";
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("projectId");
  const projects = (await query(
    `SELECT p.*, (SELECT count(*)::int FROM knowledge_nodes n WHERE n.project_id=p.id) node_count
     FROM projects p ORDER BY p.updated_at DESC, p.created_at DESC`
  )).rows;
  if (!projects.length) return json({ projects: [], project: null });
  const project = projects.find((p) => p.id === requested) ?? projects[0];
  const [workflows, nodes, roadmap, activity, metrics, profile, resources, relations] = await Promise.all([
    query("SELECT * FROM workflows WHERE project_id=$1 ORDER BY position,name", [project.id]),
    query(`SELECT id,project_id,workflow_id,parent_id,node_type,title,slug,summary,content,status,metadata,current_version,position,created_at,updated_at
           FROM knowledge_nodes WHERE project_id=$1 ORDER BY position,title`, [project.id]),
    query("SELECT * FROM roadmap_items WHERE project_id=$1 ORDER BY position,created_at", [project.id]),
    query("SELECT * FROM activity_log WHERE project_id=$1 ORDER BY created_at DESC LIMIT 80", [project.id]),
    query(`SELECT
      (SELECT count(*)::int FROM knowledge_nodes WHERE project_id=$1) knowledge,
      (SELECT count(*)::int FROM workflows WHERE project_id=$1) workflows,
      (SELECT count(*)::int FROM roadmap_items WHERE project_id=$1 AND status <> 'done') open_roadmap,
      (SELECT count(*)::int FROM knowledge_versions v JOIN knowledge_nodes n ON n.id=v.node_id WHERE n.project_id=$1) versions,
      (SELECT count(*)::int FROM activity_log WHERE project_id=$1 AND created_at >= now()-interval '7 days') changes_7d`, [project.id]),
    query("SELECT * FROM project_profiles WHERE project_id=$1", [project.id]),
    query(`SELECT * FROM project_resources
           WHERE project_id=$1
           ORDER BY is_primary DESC,kind,name,environment`, [project.id]),
    query(`SELECT r.id,r.project_id,r.source_node_id,r.target_node_id,r.relation_type,r.created_at,
                  s.title source_title,t.title target_title
           FROM relations r
           JOIN knowledge_nodes s ON s.id=r.source_node_id
           JOIN knowledge_nodes t ON t.id=r.target_node_id
           WHERE r.project_id=$1
           ORDER BY r.created_at DESC`, [project.id]),
  ]);
  return json({
    projects,
    project,
    workflows: workflows.rows,
    nodes: nodes.rows,
    roadmap: roadmap.rows,
    activity: activity.rows,
    metrics: metrics.rows[0],
    profile: profile.rows[0] || null,
    resources: resources.rows,
    relations: relations.rows,
  });
}
