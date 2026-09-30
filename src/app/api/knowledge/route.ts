import { transaction } from "@/lib/db";
import { json, slugify } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  if (!body.projectId || !title) return json({ error: "projectId and title are required" }, { status: 400 });

  const node = await transaction(async (client) => {
    const slug = `${slugify(title)}-${Date.now().toString(36)}`;
    const inserted = await client.query(
      `INSERT INTO knowledge_nodes(
        project_id,workflow_id,parent_id,node_type,title,slug,summary,content,status,metadata,position
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        body.projectId, body.workflowId || null, body.parentId || null, body.nodeType || "document",
        title, slug, body.summary || "", body.content || "", body.status || "active",
        body.metadata || {}, Number(body.position || 0),
      ],
    );
    const n = inserted.rows[0];
    await client.query(
      `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
       VALUES($1,1,$2,$3,$4,$5,$6,'user')`,
      [n.id,n.title,n.summary,n.content,n.metadata,body.changeNote || "Initial version"],
    );
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'knowledge',$2,'created',$3,$4,'user')`,
      [n.project_id,n.id,`Created: ${n.title}`,JSON.stringify({ nodeType:n.node_type, version:1 })],
    );
    return n;
  });

  return json({ node }, { status: 201 });
}
