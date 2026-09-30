import { query, transaction } from "@/lib/db";
import { json } from "@/lib/utils";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return json({ error: "projectId is required" }, { status: 400 });

  const [project, profile, resources] = await Promise.all([
    query("SELECT * FROM projects WHERE id=$1", [projectId]),
    query("SELECT * FROM project_profiles WHERE project_id=$1", [projectId]),
    query(
      `SELECT * FROM project_resources
       WHERE project_id=$1
       ORDER BY is_primary DESC,kind,name,environment`,
      [projectId],
    ),
  ]);

  if (!project.rows[0]) return json({ error: "Project not found" }, { status: 404 });
  return json({
    project: project.rows[0],
    profile: profile.rows[0] || null,
    resources: resources.rows,
  });
}

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.projectId) return json({ error: "projectId is required" }, { status: 400 });

  const allowed = [
    "primary_domain",
    "repository_url",
    "default_branch",
    "server_host",
    "server_alias",
    "deploy_path",
    "web_root",
    "env_path",
    "compose_path",
    "runtime",
    "healthcheck_url",
    "readme_md",
    "agent_rules_md",
  ] as const;

  const result = await transaction(async (client) => {
    const project = await client.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE", [body.projectId]);
    if (!project.rows[0]) return null;

    await client.query(
      "INSERT INTO project_profiles(project_id) VALUES($1) ON CONFLICT(project_id) DO NOTHING",
      [body.projectId],
    );
    const current = (
      await client.query("SELECT * FROM project_profiles WHERE project_id=$1 FOR UPDATE", [body.projectId])
    ).rows[0];

    const next: Record<string, unknown> = {};
    for (const key of allowed) next[key] = body[key] === undefined ? current[key] : body[key];
    const metadata = body.metadata
      ? { ...(current.metadata || {}), ...body.metadata }
      : current.metadata || {};

    const updated = await client.query(
      `UPDATE project_profiles SET
        primary_domain=$2,
        repository_url=$3,
        default_branch=$4,
        server_host=$5,
        server_alias=$6,
        deploy_path=$7,
        web_root=$8,
        env_path=$9,
        compose_path=$10,
        runtime=$11,
        healthcheck_url=$12,
        readme_md=$13,
        agent_rules_md=$14,
        metadata=$15,
        updated_at=now()
       WHERE project_id=$1
       RETURNING *`,
      [
        body.projectId,
        next.primary_domain,
        next.repository_url,
        next.default_branch,
        next.server_host,
        next.server_alias,
        next.deploy_path,
        next.web_root,
        next.env_path,
        next.compose_path,
        next.runtime,
        next.healthcheck_url,
        next.readme_md,
        next.agent_rules_md,
        metadata,
      ],
    );

    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'project_profile',$1,'updated',$2,$3,'user')`,
      [
        body.projectId,
        `Project profile updated: ${project.rows[0].name}`,
        JSON.stringify({ changeNote: body.changeNote || "Updated from project profile UI" }),
      ],
    );
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [body.projectId]);

    return updated.rows[0];
  });

  if (!result) return json({ error: "Project not found" }, { status: 404 });
  return json({ profile: result });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  if (!body.projectId || !body.kind || !body.name || !body.value) {
    return json({ error: "projectId, kind, name and value are required" }, { status: 400 });
  }

  const resource = await transaction(async (client) => {
    const project = await client.query("SELECT id,name FROM projects WHERE id=$1", [body.projectId]);
    if (!project.rows[0]) return null;

    const r = await client.query(
      `INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(project_id,kind,name,environment)
       DO UPDATE SET
         value=EXCLUDED.value,
         is_primary=EXCLUDED.is_primary,
         metadata=project_resources.metadata || EXCLUDED.metadata,
         updated_at=now()
       RETURNING *`,
      [
        body.projectId,
        String(body.kind),
        String(body.name),
        String(body.value),
        String(body.environment || "production"),
        Boolean(body.isPrimary),
        body.metadata || {},
      ],
    );

    await client.query(
      `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
       VALUES($1,'project_resource',$2,'updated',$3,$4,'user')`,
      [
        body.projectId,
        r.rows[0].id,
        `Resource updated: ${body.kind}/${body.name}`,
        JSON.stringify({ environment: body.environment || "production" }),
      ],
    );
    await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [body.projectId]);
    return r.rows[0];
  });

  if (!resource) return json({ error: "Project not found" }, { status: 404 });
  return json({ resource }, { status: 201 });
}
