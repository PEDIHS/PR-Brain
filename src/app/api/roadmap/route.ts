import { transaction } from "@/lib/db";
import { json } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.projectId || !String(body.title || "").trim()) {
    return json({ error:"projectId and title are required" },{status:400});
  }
  const item = await transaction(async (client) => {
    const r = await client.query(
      `INSERT INTO roadmap_items(project_id,workflow_id,parent_id,title,description,status,priority,progress,target_date,position)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [body.projectId,body.workflowId||null,body.parentId||null,body.title,body.description||"",
       body.status||"planned",body.priority||"medium",Number(body.progress||0),body.targetDate||null,Number(body.position||0)],
    );
    const i = r.rows[0];
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'roadmap',$2,'created',$3,$4,'user')`,
      [i.project_id,i.id,`Roadmap: ${i.title}`,JSON.stringify({status:i.status,priority:i.priority})],
    );
    return i;
  });
  return json({ item },{status:201});
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.id) return json({ error:"id is required" },{status:400});
  const item = await transaction(async (client) => {
    const current = await client.query("SELECT * FROM roadmap_items WHERE id=$1 FOR UPDATE",[body.id]);
    if (!current.rows[0]) return null;
    const c = current.rows[0];
    const r = await client.query(
      `UPDATE roadmap_items SET title=$2,description=$3,status=$4,priority=$5,progress=$6,target_date=$7,
       workflow_id=$8,parent_id=$9,updated_at=now() WHERE id=$1 RETURNING *`,
      [body.id,body.title??c.title,body.description??c.description,body.status??c.status,
       body.priority??c.priority,body.progress??c.progress,body.targetDate===undefined?c.target_date:body.targetDate,
       body.workflowId===undefined?c.workflow_id:body.workflowId,body.parentId===undefined?c.parent_id:body.parentId],
    );
    const i = r.rows[0];
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'roadmap',$2,'updated',$3,$4,'user')`,
      [i.project_id,i.id,`Roadmap updated: ${i.title}`,JSON.stringify({status:i.status,progress:i.progress})],
    );
    return i;
  });
  if (!item) return json({ error:"Not found" },{status:404});
  return json({ item });
}
