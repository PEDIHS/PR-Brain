import { query, transaction } from "@/lib/db";
import { json } from "@/lib/utils";

export async function GET(_: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const [node, versions, relations] = await Promise.all([
    query("SELECT * FROM knowledge_nodes WHERE id=$1",[id]),
    query("SELECT * FROM knowledge_versions WHERE node_id=$1 ORDER BY version DESC",[id]),
    query(`SELECT r.*, s.title source_title, t.title target_title
           FROM relations r JOIN knowledge_nodes s ON s.id=r.source_node_id
           JOIN knowledge_nodes t ON t.id=r.target_node_id
           WHERE r.source_node_id=$1 OR r.target_node_id=$1 ORDER BY r.created_at DESC`,[id]),
  ]);
  if (!node.rows[0]) return json({ error:"Not found" },{status:404});
  return json({ node:node.rows[0], versions:versions.rows, relations:relations.rows });
}

export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await request.json().catch(() => ({}));

  const node = await transaction(async (client) => {
    const current = await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",[id]);
    if (!current.rows[0]) return null;
    const c = current.rows[0];
    const nextVersion = c.current_version + 1;
    const values = {
      title: body.title ?? c.title,
      summary: body.summary ?? c.summary,
      content: body.content ?? c.content,
      status: body.status ?? c.status,
      metadata: body.metadata ?? c.metadata,
      workflowId: body.workflowId === undefined ? c.workflow_id : body.workflowId,
      parentId: body.parentId === undefined ? c.parent_id : body.parentId,
      nodeType: body.nodeType ?? c.node_type,
    };
    const updated = await client.query(
      `UPDATE knowledge_nodes SET title=$2,summary=$3,content=$4,status=$5,metadata=$6,
       workflow_id=$7,parent_id=$8,node_type=$9,current_version=$10,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id,values.title,values.summary,values.content,values.status,values.metadata,
       values.workflowId,values.parentId,values.nodeType,nextVersion],
    );
    const n = updated.rows[0];
    await client.query(
      `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,'user')`,
      [id,nextVersion,n.title,n.summary,n.content,n.metadata,body.changeNote || "Updated"],
    );
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'knowledge',$2,'updated',$3,$4,'user')`,
      [n.project_id,id,`Updated: ${n.title}`,JSON.stringify({ version:nextVersion, changeNote:body.changeNote || "Updated" })],
    );
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1",[n.project_id]);
    return n;
  });

  if (!node) return json({ error:"Not found" },{status:404});
  return json({ node });
}
