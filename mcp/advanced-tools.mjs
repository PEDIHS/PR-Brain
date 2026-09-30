import * as z from "zod/v4";

const NODE_TYPES = ["folder","document","decision","architecture","requirement","research","runbook","log"];

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function publicNode(row, includeContent = true) {
  if (!row) return row;
  if (includeContent) return row;
  const { content, ...rest } = row;
  return { ...rest, content_length: String(content || "").length };
}

function resolveRef(value, refs) {
  if (typeof value === "string" && value.startsWith("$")) {
    const key = value.slice(1);
    if (!refs[key]) throw new Error(`Unknown operation ref: ${value}`);
    return refs[key];
  }
  return value;
}

async function getProjectSnapshotData(client, projectId, includeContent = true) {
  const project = (await client.query("SELECT * FROM projects WHERE id=$1", [projectId])).rows[0];
  if (!project) return null;

  const profile = (await client.query("SELECT * FROM project_profiles WHERE project_id=$1", [projectId])).rows[0] || null;
  const resources = (await client.query(
    "SELECT * FROM project_resources WHERE project_id=$1 ORDER BY kind,name,environment",
    [projectId],
  )).rows;
  const workflows = (await client.query(
    "SELECT * FROM workflows WHERE project_id=$1 ORDER BY position,name",
    [projectId],
  )).rows;
  const rawNodes = (await client.query(
    "SELECT * FROM knowledge_nodes WHERE project_id=$1 ORDER BY workflow_id,parent_id,position,title",
    [projectId],
  )).rows;
  const relations = (await client.query(
    "SELECT * FROM relations WHERE project_id=$1 ORDER BY created_at,id",
    [projectId],
  )).rows;
  const roadmap = (await client.query(
    "SELECT * FROM roadmap_items WHERE project_id=$1 ORDER BY position,created_at",
    [projectId],
  )).rows;
  const tags = (await client.query(
    `SELECT t.id,t.name,t.slug,count(nt.node_id)::int AS usage_count
     FROM tags t
     JOIN workspaces w ON w.id=t.workspace_id
     LEFT JOIN node_tags nt ON nt.tag_id=t.id
     LEFT JOIN knowledge_nodes n ON n.id=nt.node_id AND n.project_id=$1
     WHERE w.id=$2
     GROUP BY t.id,t.name,t.slug
     ORDER BY t.name`,
    [projectId, project.workspace_id],
  )).rows;
  const nodeTags = (await client.query(
    `SELECT nt.node_id,t.id tag_id,t.name,t.slug
     FROM node_tags nt
     JOIN tags t ON t.id=nt.tag_id
     JOIN knowledge_nodes n ON n.id=nt.node_id
     WHERE n.project_id=$1
     ORDER BY nt.node_id,t.name`,
    [projectId],
  )).rows;

  return {
    schema_version: "project-snapshot-1.0",
    generated_at: new Date().toISOString(),
    project,
    profile,
    resources,
    workflows,
    nodes: rawNodes.map((row) => publicNode(row, includeContent)),
    relations,
    roadmap,
    tags,
    node_tags: nodeTags,
  };
}

async function createSnapshot(client, projectId, name, createdBy, includeContent = true) {
  const snapshot = await getProjectSnapshotData(client, projectId, includeContent);
  if (!snapshot) throw new Error("Project not found");
  const inserted = await client.query(
    `INSERT INTO project_snapshots(project_id,name,snapshot,created_by)
     VALUES($1,$2,$3,$4)
     RETURNING id,project_id,name,created_by,created_at`,
    [projectId, name, snapshot, createdBy || "mcp"],
  );
  return { ...inserted.rows[0], snapshot };
}

async function validateSameProject(client, projectId, table, id) {
  const allowed = {
    workflows: "workflows",
    knowledge_nodes: "knowledge_nodes",
    roadmap_items: "roadmap_items",
    project_resources: "project_resources",
  };
  if (!allowed[table]) throw new Error("Invalid validation table");
  const q = await client.query(`SELECT project_id FROM ${allowed[table]} WHERE id=$1`, [id]);
  if (!q.rows[0]) throw new Error(`${table} entity not found: ${id}`);
  if (q.rows[0].project_id !== projectId) throw new Error("Entity belongs to another project");
  return true;
}

async function appendNodeVersion(client, node, changeNote, actor = "mcp") {
  await client.query(
    `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [node.id,node.current_version,node.title,node.summary,node.content,node.metadata,changeNote,actor],
  );
}

export function registerAdvancedTools({
  registerTool,
  pool,
  tx,
  result,
  slugify,
  resolveProject,
  appendActivity,
}) {
  registerTool(
    "agent_capabilities",
    {
      description: "Return the current PR Brain agent API manifest, mutation rules and supported atomic patch operations.",
      inputSchema: z.object({}),
    },
    async () => result({
      api_version: "0.4.0",
      source_of_truth: "PostgreSQL + immutable knowledge versions + activity audit log",
      entrypoint: "open_project",
      safety: {
        cross_project_moves: "blocked",
        knowledge_cycle_creation: "blocked",
        optimistic_concurrency: "supported by expected_version in upsert_knowledge and atomic patches",
        snapshots: "supported before risky batches",
        secrets: "must never be stored in knowledge or telemetry",
      },
      capability_groups: {
        project: ["open_project","update_project","get_project_health","export_project_state","create_project_snapshot"],
        discovery: ["resolve_entity","search_project_everything","query_change_history"],
        knowledge: ["upsert_knowledge","archive_knowledge","restore_knowledge","diff_knowledge_versions","impact_analysis"],
        relations: ["list_relations","create_relation","delete_relation"],
        tags: ["list_tags","upsert_tag","set_node_tags"],
        resources: ["upsert_project_resource","delete_project_resource"],
        batch: ["apply_project_patch"],
      },
      atomic_patch_operations: [
        "project.update",
        "workflow.create",
        "workflow.update",
        "knowledge.create",
        "knowledge.update",
        "knowledge.move",
        "knowledge.archive",
        "roadmap.create",
        "roadmap.update",
        "relation.create",
        "relation.delete",
        "resource.upsert",
        "resource.delete",
      ],
      ref_syntax: "Create operations may define ref:'name'. Later IDs can use '$name' inside the same patch.",
    }),
  );

  registerTool(
    "update_project",
    {
      description: "Update project identity/state without touching its knowledge tree. Changes are audit logged.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        name: z.string().trim().min(1).max(180).optional(),
        slug: z.string().trim().min(1).max(180).regex(/^[a-z0-9-]+$/).optional(),
        description: z.string().max(10000).optional(),
        status: z.string().trim().min(1).max(80).optional(),
        accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        change_note: z.string().trim().min(1).max(4000).default("Project metadata updated"),
      }),
    },
    async (input) => {
      const updated = await tx(async (client) => {
        const p = await resolveProject(input.project, client);
        if (!p) return null;
        const row = (await client.query(
          `UPDATE projects SET
             name=$2,slug=$3,description=$4,status=$5,accent=$6,updated_at=now()
           WHERE id=$1 RETURNING *`,
          [
            p.id,
            input.name ?? p.name,
            input.slug ?? p.slug,
            input.description ?? p.description,
            input.status ?? p.status,
            input.accent ?? p.accent,
          ],
        )).rows[0];
        await appendActivity(client, {
          projectId: p.id,
          entityType: "project",
          entityId: p.id,
          action: "updated",
          title: `Project updated: ${row.name}`,
          details: { change_note: input.change_note },
        });
        return row;
      });
      return result(updated ? { project: updated } : { error: "Project not found" });
    },
  );

  registerTool(
    "resolve_entity",
    {
      description: "Resolve a human project term to workflows, knowledge nodes, roadmap items, resources or tags. Useful before mutations when the agent has names but not UUIDs.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        query: z.string().trim().min(1).max(500),
        types: z.array(z.enum(["workflow","knowledge","roadmap","resource","tag"])).default(["workflow","knowledge","roadmap","resource","tag"]),
        limit: z.number().int().min(1).max(50).default(20),
      }),
    },
    async ({ project, query, types, limit }) => {
      const p = await resolveProject(project);
      if (!p) return result({ error: "Project not found" });
      const q = query.trim();
      const matches = [];

      if (types.includes("workflow")) {
        const rows = (await pool.query(
          `SELECT id,name,slug,description,position
           FROM workflows WHERE project_id=$1
             AND (id::text=$2 OR lower(name)=lower($2) OR slug=$2 OR name ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%')
           LIMIT $3`,
          [p.id,q,limit],
        )).rows;
        matches.push(...rows.map((row) => ({ entity_type:"workflow", score: row.id === q || row.slug === q ? 100 : 70, ...row })));
      }

      if (types.includes("knowledge")) {
        const rows = (await pool.query(
          `SELECT id,workflow_id,parent_id,node_type,title,slug,summary,status,current_version,updated_at
           FROM knowledge_nodes WHERE project_id=$1
             AND (id::text=$2 OR lower(title)=lower($2) OR slug=$2 OR title ILIKE '%'||$2||'%' OR summary ILIKE '%'||$2||'%')
           ORDER BY updated_at DESC LIMIT $3`,
          [p.id,q,limit],
        )).rows;
        matches.push(...rows.map((row) => ({ entity_type:"knowledge", score: row.id === q || row.slug === q ? 100 : 80, ...row })));
      }

      if (types.includes("roadmap")) {
        const rows = (await pool.query(
          `SELECT id,workflow_id,parent_id,title,description,status,priority,progress,updated_at
           FROM roadmap_items WHERE project_id=$1
             AND (id::text=$2 OR lower(title)=lower($2) OR title ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%')
           ORDER BY updated_at DESC LIMIT $3`,
          [p.id,q,limit],
        )).rows;
        matches.push(...rows.map((row) => ({ entity_type:"roadmap", score: row.id === q ? 100 : 65, ...row })));
      }

      if (types.includes("resource")) {
        const rows = (await pool.query(
          `SELECT id,kind,name,value,environment,is_primary,metadata,updated_at
           FROM project_resources WHERE project_id=$1
             AND (id::text=$2 OR lower(name)=lower($2) OR kind ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%' OR value ILIKE '%'||$2||'%')
           ORDER BY is_primary DESC,updated_at DESC LIMIT $3`,
          [p.id,q,limit],
        )).rows;
        matches.push(...rows.map((row) => ({ entity_type:"resource", score: row.id === q ? 100 : 60, ...row })));
      }

      if (types.includes("tag")) {
        const rows = (await pool.query(
          `SELECT t.id,t.name,t.slug,count(nt.node_id)::int usage_count
           FROM tags t
           JOIN workspaces w ON w.id=t.workspace_id
           LEFT JOIN node_tags nt ON nt.tag_id=t.id
           LEFT JOIN knowledge_nodes n ON n.id=nt.node_id AND n.project_id=$1
           WHERE w.id=$2 AND (t.id::text=$3 OR lower(t.name)=lower($3) OR t.slug=$3 OR t.name ILIKE '%'||$3||'%')
           GROUP BY t.id,t.name,t.slug LIMIT $4`,
          [p.id,p.workspace_id || (await pool.query("SELECT workspace_id FROM projects WHERE id=$1",[p.id])).rows[0].workspace_id,q,limit],
        )).rows;
        matches.push(...rows.map((row) => ({ entity_type:"tag", score: row.id === q || row.slug === q ? 100 : 50, ...row })));
      }

      matches.sort((a,b) => b.score - a.score);
      return result({ project:{id:p.id,name:p.name,slug:p.slug}, query:q, matches:matches.slice(0,limit) });
    },
  );

  registerTool(
    "search_project_everything",
    {
      description: "Universal project search across knowledge content, workflows, roadmap and operational resources.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        query: z.string().trim().min(1).max(500),
        limit_per_type: z.number().int().min(1).max(30).default(10),
      }),
    },
    async ({ project, query, limit_per_type }) => {
      const p = await resolveProject(project);
      if (!p) return result({ error: "Project not found" });
      const [knowledge, workflows, roadmap, resources] = await Promise.all([
        pool.query(
          `SELECT id,workflow_id,parent_id,node_type,title,slug,summary,status,current_version,updated_at,
             ts_rank(to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,'')),plainto_tsquery('simple',$2)) rank
           FROM knowledge_nodes
           WHERE project_id=$1 AND (
             to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,'')) @@ plainto_tsquery('simple',$2)
             OR title ILIKE '%'||$2||'%' OR summary ILIKE '%'||$2||'%' OR content ILIKE '%'||$2||'%')
           ORDER BY rank DESC,updated_at DESC LIMIT $3`,
          [p.id,query,limit_per_type],
        ),
        pool.query(
          "SELECT * FROM workflows WHERE project_id=$1 AND (name ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%') ORDER BY position LIMIT $3",
          [p.id,query,limit_per_type],
        ),
        pool.query(
          "SELECT * FROM roadmap_items WHERE project_id=$1 AND (title ILIKE '%'||$2||'%' OR description ILIKE '%'||$2||'%') ORDER BY updated_at DESC LIMIT $3",
          [p.id,query,limit_per_type],
        ),
        pool.query(
          "SELECT * FROM project_resources WHERE project_id=$1 AND (kind ILIKE '%'||$2||'%' OR name ILIKE '%'||$2||'%' OR value ILIKE '%'||$2||'%') ORDER BY is_primary DESC,updated_at DESC LIMIT $3",
          [p.id,query,limit_per_type],
        ),
      ]);
      return result({
        project:{id:p.id,name:p.name,slug:p.slug},
        query,
        knowledge:knowledge.rows,
        workflows:workflows.rows,
        roadmap:roadmap.rows,
        resources:resources.rows,
        total:knowledge.rowCount+workflows.rowCount+roadmap.rowCount+resources.rowCount,
      });
    },
  );

  registerTool(
    "query_change_history",
    {
      description: "Query the project audit trail with filters for entity type, action, actor and time range.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        entity_type: z.string().trim().max(100).optional(),
        action: z.string().trim().max(100).optional(),
        actor: z.string().trim().max(180).optional(),
        since: z.string().datetime().optional(),
        until: z.string().datetime().optional(),
        limit: z.number().int().min(1).max(300).default(80),
      }),
    },
    async (input) => {
      const p = await resolveProject(input.project);
      if (!p) return result({ error:"Project not found" });
      const q = await pool.query(
        `SELECT id,entity_type,entity_id,action,title,details,actor,created_at
         FROM activity_log
         WHERE project_id=$1
           AND ($2::text IS NULL OR entity_type=$2)
           AND ($3::text IS NULL OR action=$3)
           AND ($4::text IS NULL OR actor=$4)
           AND ($5::timestamptz IS NULL OR created_at >= $5)
           AND ($6::timestamptz IS NULL OR created_at <= $6)
         ORDER BY created_at DESC LIMIT $7`,
        [p.id,input.entity_type||null,input.action||null,input.actor||null,input.since||null,input.until||null,input.limit],
      );
      return result({ project:{id:p.id,name:p.name}, changes:q.rows });
    },
  );

  registerTool(
    "get_project_health",
    {
      description: "Inspect structural/documentation health and return actionable issues without mutating the project.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        stale_days: z.number().int().min(7).max(3650).default(90),
      }),
    },
    async ({ project, stale_days }) => {
      const p = await resolveProject(project);
      if (!p) return result({ error:"Project not found" });
      const [profile, workflows, counts, stale, blocked, unlinked] = await Promise.all([
        pool.query("SELECT * FROM project_profiles WHERE project_id=$1",[p.id]),
        pool.query(
          `SELECT w.id,w.name,w.slug,count(n.id)::int node_count
           FROM workflows w LEFT JOIN knowledge_nodes n ON n.workflow_id=w.id
           WHERE w.project_id=$1 GROUP BY w.id,w.name,w.slug ORDER BY w.position`,
          [p.id],
        ),
        pool.query(
          `SELECT
             count(*)::int nodes,
             count(*) FILTER (WHERE workflow_id IS NULL)::int nodes_without_workflow,
             count(*) FILTER (WHERE summary='')::int nodes_without_summary,
             count(*) FILTER (WHERE content='' AND node_type <> 'folder')::int nodes_without_content,
             count(*) FILTER (WHERE status='draft')::int draft_nodes,
             count(*) FILTER (WHERE status='archived')::int archived_nodes
           FROM knowledge_nodes WHERE project_id=$1`,
          [p.id],
        ),
        pool.query(
          `SELECT id,title,node_type,updated_at
           FROM knowledge_nodes
           WHERE project_id=$1 AND status='active'
             AND updated_at < now() - make_interval(days => $2::int)
           ORDER BY updated_at ASC LIMIT 50`,
          [p.id,stale_days],
        ),
        pool.query(
          `SELECT id,title,priority,progress,updated_at
           FROM roadmap_items WHERE project_id=$1 AND status='blocked'
           ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,updated_at DESC`,
          [p.id],
        ),
        pool.query(
          `SELECT n.id,n.title,n.node_type
           FROM knowledge_nodes n
           LEFT JOIN relations r ON r.source_node_id=n.id OR r.target_node_id=n.id
           WHERE n.project_id=$1 AND n.node_type IN ('architecture','decision','requirement')
           GROUP BY n.id,n.title,n.node_type
           HAVING count(r.id)=0
           ORDER BY n.updated_at DESC LIMIT 50`,
          [p.id],
        ),
      ]);

      const issues = [];
      const pr = profile.rows[0];
      if (!pr) issues.push({severity:"high",code:"missing_profile",message:"Project has no operational profile"});
      else {
        for (const field of ["primary_domain","repository_url","server_host","deploy_path"]) {
          if (!pr[field]) issues.push({severity:"medium",code:`missing_${field}`,message:`Operational profile is missing ${field}`});
        }
      }
      for (const w of workflows.rows) {
        if (w.node_count===0) issues.push({severity:"low",code:"empty_workflow",entity_id:w.id,message:`Workflow ${w.name} has no knowledge nodes`});
      }
      if (counts.rows[0].nodes_without_workflow) issues.push({severity:"medium",code:"unscoped_nodes",count:counts.rows[0].nodes_without_workflow,message:"Knowledge nodes exist without a workflow"});
      if (blocked.rowCount) issues.push({severity:"high",code:"blocked_roadmap",count:blocked.rowCount,message:"Roadmap contains blocked items"});
      if (stale.rowCount) issues.push({severity:"low",code:"stale_knowledge",count:stale.rowCount,message:`Active knowledge has not been updated in ${stale_days}+ days`});
      if (unlinked.rowCount) issues.push({severity:"medium",code:"unlinked_core_nodes",count:unlinked.rowCount,message:"Architecture/decision/requirement nodes have no explicit relations"});

      const penalty = issues.reduce((sum,i)=>sum+(i.severity==="high"?15:i.severity==="medium"?7:3),0);
      return result({
        project:{id:p.id,name:p.name,slug:p.slug},
        health_score:Math.max(0,100-penalty),
        counts:counts.rows[0],
        workflow_health:workflows.rows,
        issues,
        stale_nodes:stale.rows,
        blocked_roadmap:blocked.rows,
        unlinked_core_nodes:unlinked.rows,
      });
    },
  );

  registerTool(
    "export_project_state",
    {
      description: "Export the complete deterministic project state for backup, migration, inspection or offline reasoning.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        include_content: z.boolean().default(true),
      }),
    },
    async ({ project, include_content }) => {
      const p = await resolveProject(project);
      if (!p) return result({ error:"Project not found" });
      const snapshot = await getProjectSnapshotData(pool,p.id,include_content);
      return result(snapshot);
    },
  );

  registerTool(
    "create_project_snapshot",
    {
      description: "Persist a full project snapshot before risky or large changes.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        name: z.string().trim().min(1).max(300).default("Agent snapshot"),
        include_content: z.boolean().default(true),
      }),
    },
    async ({ project, name, include_content }) => {
      const snapshot = await tx(async (client) => {
        const p = await resolveProject(project,client);
        if (!p) return null;
        const created = await createSnapshot(client,p.id,name,"mcp",include_content);
        await appendActivity(client,{
          projectId:p.id,entityType:"snapshot",entityId:created.id,action:"created",
          title:`Snapshot created: ${name}`,details:{include_content}
        });
        return created;
      });
      return result(snapshot ? { snapshot:{...snapshot,snapshot:undefined} } : { error:"Project not found" });
    },
  );

  registerTool(
    "list_project_snapshots",
    {
      description: "List stored project snapshots without returning their large snapshot payload.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    async ({ project, limit }) => {
      const p = await resolveProject(project);
      if (!p) return result({ error:"Project not found" });
      const q = await pool.query(
        `SELECT id,project_id,name,created_by,created_at,
          jsonb_array_length(coalesce(snapshot->'nodes','[]'::jsonb)) node_count,
          jsonb_array_length(coalesce(snapshot->'workflows','[]'::jsonb)) workflow_count
         FROM project_snapshots WHERE project_id=$1 ORDER BY created_at DESC LIMIT $2`,
        [p.id,limit],
      );
      return result({ project:{id:p.id,name:p.name}, snapshots:q.rows });
    },
  );

  registerTool(
    "get_project_snapshot",
    {
      description: "Read one previously stored project snapshot.",
      inputSchema: z.object({
        snapshot_id: z.string().uuid(),
      }),
    },
    async ({ snapshot_id }) => {
      const q = await pool.query("SELECT * FROM project_snapshots WHERE id=$1",[snapshot_id]);
      return result(q.rows[0] ? { snapshot:q.rows[0] } : { error:"Snapshot not found" });
    },
  );

  registerTool(
    "diff_knowledge_versions",
    {
      description: "Compare two immutable versions of a knowledge node and identify changed fields.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        from_version: z.number().int().min(1),
        to_version: z.number().int().min(1).optional(),
        include_content: z.boolean().default(false),
      }),
    },
    async ({ node_id, from_version, to_version, include_content }) => {
      const current = (await pool.query("SELECT id,title,current_version FROM knowledge_nodes WHERE id=$1",[node_id])).rows[0];
      if (!current) return result({ error:"Knowledge node not found" });
      const targetVersion = to_version || current.current_version;
      const q = await pool.query(
        `SELECT version,title,summary,content,metadata,change_note,actor,created_at
         FROM knowledge_versions WHERE node_id=$1 AND version=ANY($2::int[])
         ORDER BY version`,
        [node_id,[from_version,targetVersion]],
      );
      const byVersion = new Map(q.rows.map(r=>[r.version,r]));
      const before = byVersion.get(from_version);
      const after = byVersion.get(targetVersion);
      if (!before || !after) return result({ error:"One or both versions were not found", available_versions:(await pool.query("SELECT version FROM knowledge_versions WHERE node_id=$1 ORDER BY version",[node_id])).rows.map(r=>r.version) });
      const fields = ["title","summary","content","metadata"];
      const changed_fields = fields.filter((key)=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
      return result({
        node:{id:current.id,title:current.title},
        from_version,
        to_version:targetVersion,
        changed_fields,
        before:{
          title:before.title,summary:before.summary,metadata:before.metadata,change_note:before.change_note,actor:before.actor,created_at:before.created_at,
          content:include_content?before.content:undefined,content_length:String(before.content||"").length,
        },
        after:{
          title:after.title,summary:after.summary,metadata:after.metadata,change_note:after.change_note,actor:after.actor,created_at:after.created_at,
          content:include_content?after.content:undefined,content_length:String(after.content||"").length,
        },
      });
    },
  );

  registerTool(
    "impact_analysis",
    {
      description: "Trace hierarchy and explicit relations around a knowledge node to estimate which project entities may be affected by a change.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        depth: z.number().int().min(1).max(6).default(3),
      }),
    },
    async ({ node_id, depth }) => {
      const start = (await pool.query(
        "SELECT id,project_id,workflow_id,parent_id,node_type,title,summary,status,current_version FROM knowledge_nodes WHERE id=$1",
        [node_id],
      )).rows[0];
      if (!start) return result({ error:"Knowledge node not found" });

      const [nodesQ, relationsQ] = await Promise.all([
        pool.query(
          "SELECT id,workflow_id,parent_id,node_type,title,summary,status,current_version,updated_at FROM knowledge_nodes WHERE project_id=$1",
          [start.project_id],
        ),
        pool.query(
          "SELECT id,source_node_id,target_node_id,relation_type,created_at FROM relations WHERE project_id=$1",
          [start.project_id],
        ),
      ]);
      const nodeMap = new Map(nodesQ.rows.map(n=>[n.id,n]));
      const adjacency = new Map();
      const add = (a,b,kind,label) => {
        const list=adjacency.get(a)||[];
        list.push({to:b,kind,label});
        adjacency.set(a,list);
      };
      for(const n of nodesQ.rows) {
        if(n.parent_id) {
          add(n.parent_id,n.id,"hierarchy","child");
          add(n.id,n.parent_id,"hierarchy","parent");
        }
      }
      for(const r of relationsQ.rows) {
        add(r.source_node_id,r.target_node_id,"relation",r.relation_type);
        add(r.target_node_id,r.source_node_id,"relation",r.relation_type);
      }

      const seen=new Map([[node_id,{distance:0,via:null}]]);
      const queue=[node_id];
      while(queue.length) {
        const current=queue.shift();
        const state=seen.get(current);
        if(state.distance>=depth) continue;
        for(const edge of adjacency.get(current)||[]) {
          if(seen.has(edge.to)) continue;
          seen.set(edge.to,{distance:state.distance+1,via:{from:current,kind:edge.kind,label:edge.label}});
          queue.push(edge.to);
        }
      }
      const impacted=[...seen.entries()]
        .filter(([id])=>id!==node_id)
        .map(([id,state])=>({ ...nodeMap.get(id), distance:state.distance, via:state.via }))
        .sort((a,b)=>a.distance-b.distance || a.title.localeCompare(b.title));
      return result({
        source:start,
        depth,
        impacted_count:impacted.length,
        impacted,
        relations:relationsQ.rows.filter(r=>seen.has(r.source_node_id)&&seen.has(r.target_node_id)),
      });
    },
  );

  registerTool(
    "upsert_knowledge",
    {
      description: "Idempotently create or update a knowledge node by node_id or stable slug, with optimistic concurrency and immutable versions.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        node_id: z.string().uuid().optional(),
        slug: z.string().trim().min(1).max(300).optional(),
        workflow_id: z.string().uuid().nullable().optional(),
        parent_id: z.string().uuid().nullable().optional(),
        node_type: z.enum(NODE_TYPES).optional(),
        title: z.string().trim().min(1).max(300),
        summary: z.string().max(6000).optional(),
        content: z.string().max(200000).optional(),
        status: z.string().trim().max(80).optional(),
        metadata: z.record(z.string(),z.unknown()).optional(),
        expected_version: z.number().int().min(1).optional(),
        change_note: z.string().trim().min(1).max(4000).default("Knowledge upserted through agent API"),
      }),
    },
    async (input) => {
      const out = await tx(async (client) => {
        const p=await resolveProject(input.project,client);
        if(!p) return {error:"Project not found"};
        let current=null;
        if(input.node_id) current=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 AND project_id=$2 FOR UPDATE",[input.node_id,p.id])).rows[0]||null;
        else if(input.slug) current=(await client.query("SELECT * FROM knowledge_nodes WHERE slug=$1 AND project_id=$2 FOR UPDATE",[input.slug,p.id])).rows[0]||null;

        if(current) {
          if(input.expected_version && current.current_version!==input.expected_version) {
            return {error:"Version conflict",expected_version:input.expected_version,current_version:current.current_version,node_id:current.id};
          }
          const version=current.current_version+1;
          const updated=(await client.query(
            `UPDATE knowledge_nodes SET workflow_id=$2,parent_id=$3,node_type=$4,title=$5,summary=$6,content=$7,status=$8,metadata=$9,current_version=$10,updated_at=now()
             WHERE id=$1 RETURNING *`,
            [current.id,input.workflow_id===undefined?current.workflow_id:input.workflow_id,input.parent_id===undefined?current.parent_id:input.parent_id,input.node_type??current.node_type,input.title,input.summary??current.summary,input.content??current.content,input.status??current.status,input.metadata??current.metadata,version],
          )).rows[0];
          await appendNodeVersion(client,updated,input.change_note);
          await appendActivity(client,{projectId:p.id,entityType:"knowledge",entityId:updated.id,action:"updated",title:`Updated: ${updated.title}`,details:{version,change_note:input.change_note}});
          await client.query("UPDATE projects SET updated_at=now() WHERE id=$1",[p.id]);
          return {created:false,node:updated};
        }

        if(input.workflow_id) await validateSameProject(client,p.id,"workflows",input.workflow_id);
        if(input.parent_id) await validateSameProject(client,p.id,"knowledge_nodes",input.parent_id);
        const slug=input.slug||`${slugify(input.title)}-${Date.now().toString(36)}`;
        const max=(await client.query("SELECT coalesce(max(position),0)::int max FROM knowledge_nodes WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2",[p.id,input.parent_id||null])).rows[0].max;
        const created=(await client.query(
          `INSERT INTO knowledge_nodes(project_id,workflow_id,parent_id,node_type,title,slug,summary,content,status,metadata,current_version,position)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11) RETURNING *`,
          [p.id,input.workflow_id||null,input.parent_id||null,input.node_type||"document",input.title,slug,input.summary||"",input.content||"",input.status||"active",input.metadata||{},max+10],
        )).rows[0];
        await appendNodeVersion(client,created,input.change_note);
        await appendActivity(client,{projectId:p.id,entityType:"knowledge",entityId:created.id,action:"created",title:`Created: ${created.title}`,details:{version:1,change_note:input.change_note}});
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1",[p.id]);
        return {created:true,node:created};
      });
      return result(out);
    },
  );

  registerTool(
    "archive_knowledge",
    {
      description: "Archive one knowledge node or an entire subtree while preserving every item and creating version/audit records.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        recursive: z.boolean().default(false),
        reason: z.string().trim().min(1).max(4000).default("Archived by agent"),
      }),
    },
    async ({ node_id, recursive, reason }) => {
      const out=await tx(async(client)=>{
        const root=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",[node_id])).rows[0];
        if(!root) return {error:"Knowledge node not found"};
        let ids=[node_id];
        if(recursive) {
          ids=(await client.query(
            `WITH RECURSIVE tree AS (
               SELECT id FROM knowledge_nodes WHERE id=$1
               UNION ALL SELECT n.id FROM knowledge_nodes n JOIN tree t ON n.parent_id=t.id
             ) SELECT id FROM tree`,[node_id]
          )).rows.map(r=>r.id);
        }
        const archived=[];
        for(const id of ids) {
          const n=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",[id])).rows[0];
          if(!n||n.status==="archived") continue;
          const metadata={...(n.metadata||{}),archived_from_status:n.status,archived_at:new Date().toISOString()};
          const updated=(await client.query(
            "UPDATE knowledge_nodes SET status='archived',metadata=$2,current_version=current_version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id,metadata],
          )).rows[0];
          await appendNodeVersion(client,updated,reason);
          archived.push(updated);
        }
        await appendActivity(client,{projectId:root.project_id,entityType:"knowledge",entityId:root.id,action:"archived",title:`Archived: ${root.title}`,details:{recursive,count:archived.length,reason}});
        return {root_id:root.id,archived_count:archived.length,nodes:archived.map(n=>({id:n.id,title:n.title,current_version:n.current_version}))};
      });
      return result(out);
    },
  );

  registerTool(
    "restore_knowledge",
    {
      description: "Restore an archived knowledge node or subtree to its pre-archive status when recorded.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        recursive: z.boolean().default(false),
        reason: z.string().trim().min(1).max(4000).default("Restored by agent"),
      }),
    },
    async ({ node_id, recursive, reason }) => {
      const out=await tx(async(client)=>{
        const root=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",[node_id])).rows[0];
        if(!root) return {error:"Knowledge node not found"};
        let ids=[node_id];
        if(recursive) ids=(await client.query(
          `WITH RECURSIVE tree AS (
             SELECT id FROM knowledge_nodes WHERE id=$1
             UNION ALL SELECT n.id FROM knowledge_nodes n JOIN tree t ON n.parent_id=t.id
           ) SELECT id FROM tree`,[node_id]
        )).rows.map(r=>r.id);
        const restored=[];
        for(const id of ids) {
          const n=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",[id])).rows[0];
          if(!n||n.status!=="archived") continue;
          const previous=n.metadata?.archived_from_status||"active";
          const metadata={...(n.metadata||{})};
          delete metadata.archived_from_status; delete metadata.archived_at;
          const updated=(await client.query(
            "UPDATE knowledge_nodes SET status=$2,metadata=$3,current_version=current_version+1,updated_at=now() WHERE id=$1 RETURNING *",
            [id,previous,metadata],
          )).rows[0];
          await appendNodeVersion(client,updated,reason);
          restored.push(updated);
        }
        await appendActivity(client,{projectId:root.project_id,entityType:"knowledge",entityId:root.id,action:"restored",title:`Restored: ${root.title}`,details:{recursive,count:restored.length,reason}});
        return {root_id:root.id,restored_count:restored.length,nodes:restored.map(n=>({id:n.id,title:n.title,status:n.status,current_version:n.current_version}))};
      });
      return result(out);
    },
  );

  registerTool(
    "list_relations",
    {
      description: "List explicit knowledge relations for a whole project or one node.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300).optional(),
        node_id: z.string().uuid().optional(),
        relation_type: z.string().trim().max(80).optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }).refine(v=>Boolean(v.project||v.node_id),{message:"project or node_id is required"}),
    },
    async ({ project, node_id, relation_type, limit }) => {
      let projectId=null;
      if(project) {
        const p=await resolveProject(project);
        if(!p) return result({error:"Project not found"});
        projectId=p.id;
      } else {
        const n=(await pool.query("SELECT project_id FROM knowledge_nodes WHERE id=$1",[node_id])).rows[0];
        if(!n) return result({error:"Knowledge node not found"});
        projectId=n.project_id;
      }
      const q=await pool.query(
        `SELECT r.id,r.project_id,r.source_node_id,r.target_node_id,r.relation_type,r.created_at,
                s.title source_title,s.node_type source_type,t.title target_title,t.node_type target_type
         FROM relations r
         JOIN knowledge_nodes s ON s.id=r.source_node_id
         JOIN knowledge_nodes t ON t.id=r.target_node_id
         WHERE r.project_id=$1
           AND ($2::uuid IS NULL OR r.source_node_id=$2 OR r.target_node_id=$2)
           AND ($3::text IS NULL OR r.relation_type=$3)
         ORDER BY r.created_at DESC LIMIT $4`,
        [projectId,node_id||null,relation_type||null,limit],
      );
      return result({project_id:projectId,relations:q.rows});
    },
  );

  registerTool(
    "delete_relation",
    {
      description: "Delete one explicit knowledge relation. The deletion is audit logged.",
      inputSchema: z.object({
        relation_id: z.string().uuid(),
        reason: z.string().trim().min(1).max(4000).default("Relation removed by agent"),
      }),
    },
    async ({ relation_id, reason }) => {
      const out=await tx(async(client)=>{
        const r=(await client.query("SELECT * FROM relations WHERE id=$1 FOR UPDATE",[relation_id])).rows[0];
        if(!r) return null;
        await client.query("DELETE FROM relations WHERE id=$1",[relation_id]);
        await appendActivity(client,{projectId:r.project_id,entityType:"relation",entityId:r.id,action:"deleted",title:`Relation removed: ${r.relation_type}`,details:{source_node_id:r.source_node_id,target_node_id:r.target_node_id,reason}});
        return r;
      });
      return result(out?{deleted:out}:{error:"Relation not found"});
    },
  );

  registerTool(
    "list_tags",
    {
      description: "List workspace tags and their usage counts inside a project.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
      }),
    },
    async ({ project }) => {
      const p=await resolveProject(project);
      if(!p) return result({error:"Project not found"});
      const workspaceId=(await pool.query("SELECT workspace_id FROM projects WHERE id=$1",[p.id])).rows[0].workspace_id;
      const q=await pool.query(
        `SELECT t.id,t.name,t.slug,count(n.id)::int usage_count
         FROM tags t
         LEFT JOIN node_tags nt ON nt.tag_id=t.id
         LEFT JOIN knowledge_nodes n ON n.id=nt.node_id AND n.project_id=$1
         WHERE t.workspace_id=$2
         GROUP BY t.id,t.name,t.slug ORDER BY t.name`,
        [p.id,workspaceId],
      );
      return result({project:{id:p.id,name:p.name},tags:q.rows});
    },
  );

  registerTool(
    "upsert_tag",
    {
      description: "Create or update a reusable workspace tag.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        name: z.string().trim().min(1).max(120),
        slug: z.string().trim().min(1).max(120).regex(/^[a-z0-9-]+$/).optional(),
      }),
    },
    async ({ project, name, slug }) => {
      const p=await resolveProject(project);
      if(!p) return result({error:"Project not found"});
      const workspaceId=(await pool.query("SELECT workspace_id FROM projects WHERE id=$1",[p.id])).rows[0].workspace_id;
      const tagSlug=slug||slugify(name);
      const q=await pool.query(
        `INSERT INTO tags(workspace_id,name,slug) VALUES($1,$2,$3)
         ON CONFLICT(workspace_id,slug) DO UPDATE SET name=EXCLUDED.name
         RETURNING *`,
        [workspaceId,name,tagSlug],
      );
      return result({tag:q.rows[0]});
    },
  );

  registerTool(
    "set_node_tags",
    {
      description: "Replace, add or remove tags on a knowledge node. Tag names are created automatically when needed.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        tags: z.array(z.string().trim().min(1).max(120)).max(50),
        mode: z.enum(["replace","add","remove"]).default("replace"),
      }),
    },
    async ({ node_id, tags, mode }) => {
      const out=await tx(async(client)=>{
        const node=(await client.query("SELECT n.*,p.workspace_id FROM knowledge_nodes n JOIN projects p ON p.id=n.project_id WHERE n.id=$1 FOR UPDATE",[node_id])).rows[0];
        if(!node) return null;
        const tagIds=[];
        for(const name of tags) {
          const slug=slugify(name);
          const tag=(await client.query(
            `INSERT INTO tags(workspace_id,name,slug) VALUES($1,$2,$3)
             ON CONFLICT(workspace_id,slug) DO UPDATE SET name=EXCLUDED.name RETURNING id,name,slug`,
            [node.workspace_id,name,slug],
          )).rows[0];
          tagIds.push(tag.id);
        }
        if(mode==="replace") {
          await client.query("DELETE FROM node_tags WHERE node_id=$1",[node_id]);
          for(const id of tagIds) await client.query("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[node_id,id]);
        } else if(mode==="add") {
          for(const id of tagIds) await client.query("INSERT INTO node_tags(node_id,tag_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[node_id,id]);
        } else {
          for(const id of tagIds) await client.query("DELETE FROM node_tags WHERE node_id=$1 AND tag_id=$2",[node_id,id]);
        }
        const current=(await client.query(
          "SELECT t.id,t.name,t.slug FROM node_tags nt JOIN tags t ON t.id=nt.tag_id WHERE nt.node_id=$1 ORDER BY t.name",
          [node_id],
        )).rows;
        await appendActivity(client,{projectId:node.project_id,entityType:"knowledge",entityId:node_id,action:"tags_updated",title:`Tags updated: ${node.title}`,details:{mode,tags}});
        return {node_id,current_tags:current};
      });
      return result(out||{error:"Knowledge node not found"});
    },
  );

  registerTool(
    "delete_project_resource",
    {
      description: "Delete a registered project resource/location while keeping an audit event.",
      inputSchema: z.object({
        resource_id: z.string().uuid(),
        reason: z.string().trim().min(1).max(4000).default("Resource removed by agent"),
      }),
    },
    async ({ resource_id, reason }) => {
      const out=await tx(async(client)=>{
        const r=(await client.query("SELECT * FROM project_resources WHERE id=$1 FOR UPDATE",[resource_id])).rows[0];
        if(!r) return null;
        await client.query("DELETE FROM project_resources WHERE id=$1",[resource_id]);
        await appendActivity(client,{projectId:r.project_id,entityType:"project_resource",entityId:r.id,action:"deleted",title:`Resource removed: ${r.kind}/${r.name}`,details:{value:r.value,environment:r.environment,reason}});
        return r;
      });
      return result(out?{deleted:out}:{error:"Resource not found"});
    },
  );

  registerTool(
    "apply_project_patch",
    {
      description: "Apply many related project changes atomically. Supports dry-run, temporary refs between operations, optimistic knowledge versions and an automatic pre-change snapshot.",
      inputSchema: z.object({
        project: z.string().trim().min(1).max(300),
        change_note: z.string().trim().min(1).max(4000),
        dry_run: z.boolean().default(true),
        create_snapshot_before: z.boolean().default(true),
        source_records: z.array(z.object({
          repository: z.string().trim().min(1).max(300),
          git_ref: z.string().trim().min(1).max(180).default("main"),
          file_path: z.string().trim().min(1).max(2000),
          blob_sha: z.string().trim().min(6).max(120),
          change_id: z.string().trim().min(1).max(300),
          title: z.string().max(1000).default(""),
          agent_name: z.string().max(300).default(""),
          operation_count: z.number().int().min(0).max(1000).default(0),
        })).max(100).default([]),
        operations: z.array(z.object({
          op: z.enum([
            "project.update","workflow.create","workflow.update",
            "knowledge.create","knowledge.update","knowledge.move","knowledge.archive",
            "roadmap.create","roadmap.update",
            "relation.create","relation.delete",
            "resource.upsert","resource.delete",
          ]),
          ref: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/).optional(),
          data: z.record(z.string(),z.unknown()),
        })).min(1).max(100),
      }),
    },
    async ({ project, change_note, dry_run, create_snapshot_before, source_records, operations }) => {
      const p=await resolveProject(project);
      if(!p) return result({error:"Project not found"});
      const duplicateRefs=operations.map(o=>o.ref).filter(Boolean).filter((r,i,a)=>a.indexOf(r)!==i);
      if(duplicateRefs.length) return result({error:"Duplicate operation refs",refs:[...new Set(duplicateRefs)]});

      if(dry_run) {
        return result({
          dry_run:true,
          project:{id:p.id,name:p.name,slug:p.slug},
          operation_count:operations.length,
          operations:operations.map((o,index)=>({index,op:o.op,ref:o.ref||null,data_keys:Object.keys(o.data)})),
          snapshot_will_be_created:create_snapshot_before,
          source_records,
          guidance:"Set dry_run=false to commit all operations in one PostgreSQL transaction. Any thrown validation error rolls the whole patch back.",
        });
      }

      const committed=await tx(async(client)=>{
        const locked=(await client.query("SELECT * FROM projects WHERE id=$1 FOR UPDATE",[p.id])).rows[0];
        if(!locked) throw new Error("Project disappeared before patch");

        if(source_records.length) {
          for(const source of source_records) {
            const existing=(await client.query(
              `SELECT id,applied_at FROM github_sync_applied
               WHERE repository=$1 AND file_path=$2 AND blob_sha=$3
               LIMIT 1`,
              [source.repository,source.file_path,source.blob_sha],
            )).rows[0];
            if(existing) {
              throw new Error(`GitHub changeset already applied: ${source.file_path} @ ${source.blob_sha}`);
            }
          }
        }

        let snapshotMeta=null;
        if(create_snapshot_before) {
          const snap=await createSnapshot(client,p.id,`Before patch: ${change_note.slice(0,180)}`,"mcp",true);
          snapshotMeta={id:snap.id,name:snap.name,created_at:snap.created_at};
        }

        const refs={};
        const results=[];

        for(let index=0;index<operations.length;index++) {
          const operation=operations[index];
          const d={...operation.data};
          for(const key of ["workflow_id","parent_id","node_id","item_id","source_node_id","target_node_id","relation_id","resource_id"]) {
            if(key in d) d[key]=resolveRef(d[key],refs);
          }

          let entity=null;

          if(operation.op==="project.update") {
            entity=(await client.query(
              `UPDATE projects SET
                 name=coalesce($2,name),slug=coalesce($3,slug),description=coalesce($4,description),
                 status=coalesce($5,status),accent=coalesce($6,accent),updated_at=now()
               WHERE id=$1 RETURNING *`,
              [p.id,d.name??null,d.slug??null,d.description??null,d.status??null,d.accent??null],
            )).rows[0];
          }

          else if(operation.op==="workflow.create") {
            if(!d.name) throw new Error(`Operation ${index}: workflow.create requires name`);
            const max=(await client.query("SELECT coalesce(max(position),0)::int max FROM workflows WHERE project_id=$1",[p.id])).rows[0].max;
            const slug=d.slug||`${slugify(d.name)}-${Date.now().toString(36)}-${index}`;
            entity=(await client.query(
              "INSERT INTO workflows(project_id,name,slug,description,position) VALUES($1,$2,$3,$4,$5) RETURNING *",
              [p.id,d.name,slug,d.description||"",Number.isFinite(Number(d.position))?Number(d.position):max+10],
            )).rows[0];
          }

          else if(operation.op==="workflow.update") {
            if(!d.workflow_id) throw new Error(`Operation ${index}: workflow.update requires workflow_id`);
            await validateSameProject(client,p.id,"workflows",d.workflow_id);
            entity=(await client.query(
              `UPDATE workflows SET name=coalesce($2,name),description=coalesce($3,description),position=coalesce($4,position)
               WHERE id=$1 RETURNING *`,
              [d.workflow_id,d.name??null,d.description??null,d.position??null],
            )).rows[0];
          }

          else if(operation.op==="knowledge.create") {
            if(!d.title) throw new Error(`Operation ${index}: knowledge.create requires title`);
            if(d.workflow_id) await validateSameProject(client,p.id,"workflows",d.workflow_id);
            if(d.parent_id) await validateSameProject(client,p.id,"knowledge_nodes",d.parent_id);
            const max=(await client.query("SELECT coalesce(max(position),0)::int max FROM knowledge_nodes WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2",[p.id,d.parent_id||null])).rows[0].max;
            const slug=d.slug||`${slugify(d.title)}-${Date.now().toString(36)}-${index}`;
            entity=(await client.query(
              `INSERT INTO knowledge_nodes(project_id,workflow_id,parent_id,node_type,title,slug,summary,content,status,metadata,current_version,position)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11) RETURNING *`,
              [p.id,d.workflow_id||null,d.parent_id||null,NODE_TYPES.includes(d.node_type)?d.node_type:"document",d.title,slug,d.summary||"",d.content||"",d.status||"active",d.metadata||{},Number.isFinite(Number(d.position))?Number(d.position):max+10],
            )).rows[0];
            await appendNodeVersion(client,entity,change_note);
          }

          else if(operation.op==="knowledge.update") {
            if(!d.node_id) throw new Error(`Operation ${index}: knowledge.update requires node_id`);
            const current=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 AND project_id=$2 FOR UPDATE",[d.node_id,p.id])).rows[0];
            if(!current) throw new Error(`Operation ${index}: knowledge node not found`);
            if(d.expected_version && current.current_version!==Number(d.expected_version)) throw new Error(`Operation ${index}: version conflict for ${d.node_id}; expected ${d.expected_version}, current ${current.current_version}`);
            const version=current.current_version+1;
            entity=(await client.query(
              `UPDATE knowledge_nodes SET node_type=$2,title=$3,summary=$4,content=$5,status=$6,metadata=$7,current_version=$8,updated_at=now()
               WHERE id=$1 RETURNING *`,
              [current.id,d.node_type||current.node_type,d.title??current.title,d.summary??current.summary,d.content??current.content,d.status??current.status,d.metadata??current.metadata,version],
            )).rows[0];
            await appendNodeVersion(client,entity,change_note);
          }

          else if(operation.op==="knowledge.move") {
            if(!d.node_id) throw new Error(`Operation ${index}: knowledge.move requires node_id`);
            const current=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 AND project_id=$2 FOR UPDATE",[d.node_id,p.id])).rows[0];
            if(!current) throw new Error(`Operation ${index}: knowledge node not found`);
            if(d.parent_id) {
              await validateSameProject(client,p.id,"knowledge_nodes",d.parent_id);
              const cycle=await client.query(
                `WITH RECURSIVE descendants AS (
                   SELECT id FROM knowledge_nodes WHERE parent_id=$1
                   UNION ALL SELECT n.id FROM knowledge_nodes n JOIN descendants d ON n.parent_id=d.id
                 ) SELECT 1 FROM descendants WHERE id=$2 LIMIT 1`,[current.id,d.parent_id]
              );
              if(cycle.rows[0]||d.parent_id===current.id) throw new Error(`Operation ${index}: move would create a cycle`);
            }
            if(d.workflow_id) await validateSameProject(client,p.id,"workflows",d.workflow_id);
            entity=(await client.query(
              `UPDATE knowledge_nodes SET parent_id=$2,workflow_id=$3,position=$4,current_version=current_version+1,updated_at=now()
               WHERE id=$1 RETURNING *`,
              [current.id,d.parent_id===undefined?current.parent_id:d.parent_id,d.workflow_id===undefined?current.workflow_id:d.workflow_id,d.position===undefined?current.position:Number(d.position)],
            )).rows[0];
            await appendNodeVersion(client,entity,change_note);
          }

          else if(operation.op==="knowledge.archive") {
            if(!d.node_id) throw new Error(`Operation ${index}: knowledge.archive requires node_id`);
            const current=(await client.query("SELECT * FROM knowledge_nodes WHERE id=$1 AND project_id=$2 FOR UPDATE",[d.node_id,p.id])).rows[0];
            if(!current) throw new Error(`Operation ${index}: knowledge node not found`);
            const metadata={...(current.metadata||{}),archived_from_status:current.status,archived_at:new Date().toISOString()};
            entity=(await client.query(
              "UPDATE knowledge_nodes SET status='archived',metadata=$2,current_version=current_version+1,updated_at=now() WHERE id=$1 RETURNING *",
              [current.id,metadata],
            )).rows[0];
            await appendNodeVersion(client,entity,change_note);
          }

          else if(operation.op==="roadmap.create") {
            if(!d.title) throw new Error(`Operation ${index}: roadmap.create requires title`);
            if(d.workflow_id) await validateSameProject(client,p.id,"workflows",d.workflow_id);
            const max=(await client.query("SELECT coalesce(max(position),0)::int max FROM roadmap_items WHERE project_id=$1",[p.id])).rows[0].max;
            entity=(await client.query(
              `INSERT INTO roadmap_items(project_id,workflow_id,parent_id,title,description,status,priority,progress,target_date,position)
               VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
              [p.id,d.workflow_id||null,d.parent_id||null,d.title,d.description||"",d.status||"planned",d.priority||"medium",Number(d.progress||0),d.target_date||null,Number.isFinite(Number(d.position))?Number(d.position):max+10],
            )).rows[0];
          }

          else if(operation.op==="roadmap.update") {
            if(!d.item_id) throw new Error(`Operation ${index}: roadmap.update requires item_id`);
            await validateSameProject(client,p.id,"roadmap_items",d.item_id);
            const current=(await client.query("SELECT * FROM roadmap_items WHERE id=$1 FOR UPDATE",[d.item_id])).rows[0];
            entity=(await client.query(
              `UPDATE roadmap_items SET title=$2,description=$3,status=$4,priority=$5,progress=$6,target_date=$7,updated_at=now()
               WHERE id=$1 RETURNING *`,
              [d.item_id,d.title??current.title,d.description??current.description,d.status??current.status,d.priority??current.priority,d.progress===undefined?current.progress:Number(d.progress),d.target_date===undefined?current.target_date:d.target_date],
            )).rows[0];
          }

          else if(operation.op==="relation.create") {
            if(!d.source_node_id||!d.target_node_id) throw new Error(`Operation ${index}: relation.create requires source_node_id and target_node_id`);
            if(d.source_node_id===d.target_node_id) throw new Error(`Operation ${index}: relation cannot target itself`);
            await validateSameProject(client,p.id,"knowledge_nodes",d.source_node_id);
            await validateSameProject(client,p.id,"knowledge_nodes",d.target_node_id);
            entity=(await client.query(
              `INSERT INTO relations(project_id,source_node_id,target_node_id,relation_type)
               VALUES($1,$2,$3,$4)
               ON CONFLICT(source_node_id,target_node_id,relation_type) DO UPDATE SET relation_type=EXCLUDED.relation_type
               RETURNING *`,
              [p.id,d.source_node_id,d.target_node_id,d.relation_type||"related"],
            )).rows[0];
          }

          else if(operation.op==="relation.delete") {
            if(!d.relation_id) throw new Error(`Operation ${index}: relation.delete requires relation_id`);
            const current=(await client.query("SELECT * FROM relations WHERE id=$1 AND project_id=$2 FOR UPDATE",[d.relation_id,p.id])).rows[0];
            if(!current) throw new Error(`Operation ${index}: relation not found`);
            await client.query("DELETE FROM relations WHERE id=$1",[current.id]);
            entity={...current,deleted:true};
          }

          else if(operation.op==="resource.upsert") {
            if(!d.kind||!d.name||!d.value) throw new Error(`Operation ${index}: resource.upsert requires kind,name,value`);
            entity=(await client.query(
              `INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
               VALUES($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT(project_id,kind,name,environment)
               DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=project_resources.metadata||EXCLUDED.metadata,updated_at=now()
               RETURNING *`,
              [p.id,d.kind,d.name,d.value,d.environment||"production",Boolean(d.is_primary),d.metadata||{}],
            )).rows[0];
          }

          else if(operation.op==="resource.delete") {
            if(!d.resource_id) throw new Error(`Operation ${index}: resource.delete requires resource_id`);
            const current=(await client.query("SELECT * FROM project_resources WHERE id=$1 AND project_id=$2 FOR UPDATE",[d.resource_id,p.id])).rows[0];
            if(!current) throw new Error(`Operation ${index}: resource not found`);
            await client.query("DELETE FROM project_resources WHERE id=$1",[current.id]);
            entity={...current,deleted:true};
          }

          if(!entity) throw new Error(`Operation ${index}: unsupported or empty operation result`);
          if(operation.ref) refs[operation.ref]=entity.id;

          await appendActivity(client,{
            projectId:p.id,
            entityType:"change_operation",
            entityId:isUuid(entity.id)?entity.id:null,
            action:operation.op,
            title:`Patch operation: ${operation.op}`,
            details:{index,ref:operation.ref||null,entity_id:entity.id||null,change_note},
          });

          results.push({index,op:operation.op,ref:operation.ref||null,entity});
        }

        await appendActivity(client,{
          projectId:p.id,entityType:"change_set",entityId:null,action:"committed",
          title:`Atomic project patch: ${change_note.slice(0,180)}`,
          details:{operation_count:operations.length,refs,snapshot_id:snapshotMeta?.id||null,source_records},
        });

        for(const source of source_records) {
          await client.query(
            `INSERT INTO github_sync_applied(
               project_id,repository,git_ref,file_path,blob_sha,change_id,title,agent_name,operation_count,result,applied_by
             ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'panel')
             ON CONFLICT(repository,file_path,blob_sha) DO NOTHING`,
            [
              p.id,source.repository,source.git_ref,source.file_path,source.blob_sha,source.change_id,
              source.title,source.agent_name,source.operation_count,
              { change_note, snapshot_id:snapshotMeta?.id||null },
            ],
          );
        }

        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1",[p.id]);
        return {project:{id:p.id,name:p.name,slug:p.slug},snapshot:snapshotMeta,refs,results,source_records};
      });

      return result({dry_run:false,committed:true,...committed});
    },
  );
}
