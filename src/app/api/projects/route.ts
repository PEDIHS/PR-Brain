import { transaction, query } from "@/lib/db";
import { json, slugify } from "@/lib/utils";

export async function GET() {
  return json({ projects: (await query("SELECT * FROM projects ORDER BY updated_at DESC")).rows });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  if (!name) return json({ error: "Project name is required" }, { status: 400 });

  const result = await transaction(async (client) => {
    const ws = await client.query("SELECT id FROM workspaces ORDER BY created_at LIMIT 1");
    const slug = `${slugify(name)}-${Date.now().toString(36)}`;
    const p = await client.query(
      `INSERT INTO projects(workspace_id,name,slug,description,accent)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [ws.rows[0].id, name, slug, body.description || "", body.accent || "#151A23"],
    );
    const defaults = [
      ["Product","product","Vision, requirements and product decisions",10],
      ["Engineering","engineering","Architecture, implementation and infrastructure",20],
      ["Design","design","UX, UI and design system",30],
      ["Operations","operations","Deployment, observability and runbooks",40],
    ];
    for (const item of defaults) {
      await client.query(
        "INSERT INTO workflows(project_id,name,slug,description,position) VALUES($1,$2,$3,$4,$5)",
        [p.rows[0].id, ...item],
      );
    }
    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'project',$1,'created',$2,'{}','user')`,
      [p.rows[0].id, `Project created: ${name}`],
    );
    return p.rows[0];
  });

  return json({ project: result }, { status: 201 });
}
