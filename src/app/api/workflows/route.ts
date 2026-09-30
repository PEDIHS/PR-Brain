import { transaction } from "@/lib/db";
import { json, slugify } from "@/lib/utils";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  if (!body.projectId || !name) {
    return json({ error: "projectId and name are required" }, { status: 400 });
  }

  const workflow = await transaction(async (client) => {
    const max = await client.query(
      "SELECT coalesce(max(position),0)::int max FROM workflows WHERE project_id=$1",
      [body.projectId],
    );
    const slug = `${slugify(name)}-${Date.now().toString(36)}`;
    const result = await client.query(
      `INSERT INTO workflows(project_id,name,slug,description,position)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [body.projectId,name,slug,body.description || "",max.rows[0].max + 10],
    );
    const w = result.rows[0];
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'workflow',$2,'created',$3,$4,'user')`,
      [body.projectId,w.id,`Workflow created: ${name}`,JSON.stringify({slug:w.slug})],
    );
    return w;
  });

  return json({ workflow }, { status: 201 });
}
