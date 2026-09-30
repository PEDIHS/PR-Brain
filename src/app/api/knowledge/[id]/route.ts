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
    if (!current.rows[0]) return { error:"Not found", status:404 } as const;
    const c = current.rows[0];

    const workflowId = body.workflowId === undefined ? c.workflow_id : body.workflowId;
    const parentId = body.parentId === undefined ? c.parent_id : body.parentId;

    if (parentId === id) return { error:"A node cannot be its own parent", status:400 } as const;

    if (workflowId) {
      const workflow = await client.query("SELECT id,project_id FROM workflows WHERE id=$1",[workflowId]);
      if (!workflow.rows[0]) return { error:"Workflow not found", status:400 } as const;
      if (workflow.rows[0].project_id !== c.project_id) {
        return { error:"Target workflow belongs to another project", status:400 } as const;
      }
    }

    if (parentId) {
      const parent = await client.query("SELECT id,project_id,workflow_id FROM knowledge_nodes WHERE id=$1",[parentId]);
      if (!parent.rows[0]) return { error:"Parent node not found", status:400 } as const;
      if (parent.rows[0].project_id !== c.project_id) {
        return { error:"Cross-project moves are not allowed", status:400 } as const;
      }

      const cycle = await client.query(
        `WITH RECURSIVE descendants AS (
           SELECT id FROM knowledge_nodes WHERE parent_id=$1
           UNION ALL
           SELECT child.id
           FROM knowledge_nodes child
           JOIN descendants d ON child.parent_id=d.id
         )
         SELECT 1 FROM descendants WHERE id=$2 LIMIT 1`,
        [id,parentId],
      );
      if (cycle.rows[0]) return { error:"Move rejected because it would create a tree cycle", status:400 } as const;
    }

    const nextVersion = c.current_version + 1;
    const values = {
      title: body.title ?? c.title,
      summary: body.summary ?? c.summary,
      content: body.content ?? c.content,
      status: body.status ?? c.status,
      metadata: body.metadata ?? c.metadata,
      workflowId,
      parentId,
      nodeType: body.nodeType ?? c.node_type,
      position: Number.isFinite(Number(body.position)) ? Number(body.position) : c.position,
    };

    const updated = await client.query(
      `UPDATE knowledge_nodes SET title=$2,summary=$3,content=$4,status=$5,metadata=$6,
       workflow_id=$7,parent_id=$8,node_type=$9,current_version=$10,position=$11,updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id,values.title,values.summary,values.content,values.status,values.metadata,
       values.workflowId,values.parentId,values.nodeType,nextVersion,values.position],
    );
    const n = updated.rows[0];
    const structural = c.parent_id !== n.parent_id || c.workflow_id !== n.workflow_id || c.position !== n.position;
    const changeNote = body.changeNote || (structural ? "Knowledge tree reorganized" : "Updated");

    await client.query(
      `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
       VALUES($1,$2,$3,$4,$5,$6,$7,'user')`,
      [id,nextVersion,n.title,n.summary,n.content,{
        ...(n.metadata || {}),
        ...(structural ? { structure:{ workflow_id:n.workflow_id,parent_id:n.parent_id,position:n.position } } : {}),
      },changeNote],
    );
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'knowledge',$2,$3,$4,$5,'user')`,
      [
        n.project_id,
        id,
        structural ? "moved" : "updated",
        structural ? `Moved: ${n.title}` : `Updated: ${n.title}`,
        JSON.stringify({
          version:nextVersion,
          changeNote,
          ...(structural ? {
            from_parent_id:c.parent_id,to_parent_id:n.parent_id,
            from_workflow_id:c.workflow_id,to_workflow_id:n.workflow_id,
            from_position:c.position,to_position:n.position,
          } : {}),
        }),
      ],
    );
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1",[n.project_id]);
    return { node:n } as const;
  });

  if ("error" in node) return json({ error:node.error },{status:node.status});
  return json({ node:node.node });
}
