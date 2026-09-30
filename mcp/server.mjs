import { createServer } from "node:http";
import pg from "pg";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const pool = new Pool({
  connectionString: databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
});

function result(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function slugify(input) {
  const base = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return base || `item-${Date.now().toString(36)}`;
}

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const value = await fn(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function appendActivity(client, {
  projectId,
  entityType,
  entityId = null,
  action,
  title,
  details = {},
  actor = "mcp",
}) {
  await client.query(
    `INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [projectId, entityType, entityId, action, title, details, actor],
  );
}

const handler = createMcpHandler(() => {
  const server = new McpServer(
    { name: "pr-brain", version: "0.2.0" },
    {
      capabilities: { tools: {} },
      instructions:
        "PR Brain is the structured source of truth for projects. Read project context before making material project decisions. Use write tools to persist approved facts, decisions, architecture changes, roadmap items and implementation changes.",
    },
  );

  server.registerTool(
    "list_projects",
    {
      description: "List every project in the workspace with high-level counts and update timestamps.",
      inputSchema: z.object({}),
    },
    async () => {
      const q = await pool.query(
        `SELECT p.id,p.name,p.slug,p.description,p.status,p.accent,p.created_at,p.updated_at,
          (SELECT count(*)::int FROM workflows w WHERE w.project_id=p.id) workflow_count,
          (SELECT count(*)::int FROM knowledge_nodes n WHERE n.project_id=p.id) knowledge_count,
          (SELECT count(*)::int FROM roadmap_items r WHERE r.project_id=p.id AND r.status <> 'done') open_roadmap
         FROM projects p
         ORDER BY p.updated_at DESC,p.created_at DESC`,
      );
      return result({ projects: q.rows });
    },
  );

  server.registerTool(
    "get_project_context",
    {
      description:
        "Build a compact context pack for one project: project metadata, workflows, relevant knowledge, active roadmap and recent changes. Use this before substantial work.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        query: z.string().trim().max(500).optional(),
        limit: z.number().int().min(1).max(30).default(18),
      }),
    },
    async ({ project_id, query, limit }) => {
      const project = (
        await pool.query(
          "SELECT id,name,slug,description,status,accent,created_at,updated_at FROM projects WHERE id=$1",
          [project_id],
        )
      ).rows[0];
      if (!project) return result({ error: "Project not found" });

      const workflowsPromise = pool.query(
        "SELECT id,name,slug,description,position FROM workflows WHERE project_id=$1 ORDER BY position,name",
        [project_id],
      );

      const knowledgePromise = query
        ? pool.query(
            `SELECT id,workflow_id,parent_id,node_type,title,summary,content,status,metadata,current_version,updated_at,
              ts_rank(
                to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,'')),
                plainto_tsquery('simple',$2)
              ) AS rank
             FROM knowledge_nodes
             WHERE project_id=$1 AND (
               to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,''))
               @@ plainto_tsquery('simple',$2)
               OR title ILIKE '%'||$2||'%'
               OR summary ILIKE '%'||$2||'%'
               OR content ILIKE '%'||$2||'%'
             )
             ORDER BY rank DESC,updated_at DESC
             LIMIT $3`,
            [project_id, query, limit],
          )
        : pool.query(
            `SELECT id,workflow_id,parent_id,node_type,title,summary,content,status,metadata,current_version,updated_at
             FROM knowledge_nodes
             WHERE project_id=$1
             ORDER BY updated_at DESC
             LIMIT $2`,
            [project_id, limit],
          );

      const [workflows, knowledge, roadmap, activity] = await Promise.all([
        workflowsPromise,
        knowledgePromise,
        pool.query(
          `SELECT id,workflow_id,parent_id,title,description,status,priority,progress,target_date,updated_at
           FROM roadmap_items
           WHERE project_id=$1 AND status <> 'done'
           ORDER BY
             CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             position,updated_at DESC
           LIMIT 30`,
          [project_id],
        ),
        pool.query(
          `SELECT entity_type,entity_id,action,title,details,actor,created_at
           FROM activity_log
           WHERE project_id=$1
           ORDER BY created_at DESC
           LIMIT 25`,
          [project_id],
        ),
      ]);

      return result({
        schema_version: "1.0",
        generated_at: new Date().toISOString(),
        requested_topic: query || null,
        project,
        workflows: workflows.rows,
        relevant_knowledge: knowledge.rows,
        active_roadmap: roadmap.rows,
        recent_changes: activity.rows,
      });
    },
  );

  server.registerTool(
    "search_knowledge",
    {
      description: "Search one project's structured knowledge by meaning-bearing text and exact text fragments.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        query: z.string().trim().min(1).max(500),
        limit: z.number().int().min(1).max(50).default(20),
        node_type: z.string().trim().optional(),
      }),
    },
    async ({ project_id, query, limit, node_type }) => {
      const q = await pool.query(
        `SELECT id,workflow_id,parent_id,node_type,title,summary,status,current_version,updated_at,
          ts_rank(
            to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,'')),
            plainto_tsquery('simple',$2)
          ) AS rank
         FROM knowledge_nodes
         WHERE project_id=$1
           AND ($4::text IS NULL OR node_type=$4)
           AND (
             to_tsvector('simple',coalesce(title,'')||' '||coalesce(summary,'')||' '||coalesce(content,''))
             @@ plainto_tsquery('simple',$2)
             OR title ILIKE '%'||$2||'%'
             OR summary ILIKE '%'||$2||'%'
             OR content ILIKE '%'||$2||'%'
           )
         ORDER BY rank DESC,updated_at DESC
         LIMIT $3`,
        [project_id, query, limit, node_type || null],
      );
      return result({ query, results: q.rows });
    },
  );

  server.registerTool(
    "get_knowledge_node",
    {
      description: "Read one knowledge node with its full content, immutable version history and relations.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
      }),
    },
    async ({ node_id }) => {
      const [node, versions, relations] = await Promise.all([
        pool.query("SELECT * FROM knowledge_nodes WHERE id=$1", [node_id]),
        pool.query(
          `SELECT id,version,title,summary,content,metadata,change_note,actor,created_at
           FROM knowledge_versions
           WHERE node_id=$1
           ORDER BY version DESC`,
          [node_id],
        ),
        pool.query(
          `SELECT r.id,r.relation_type,r.created_at,
            s.id source_id,s.title source_title,
            t.id target_id,t.title target_title
           FROM relations r
           JOIN knowledge_nodes s ON s.id=r.source_node_id
           JOIN knowledge_nodes t ON t.id=r.target_node_id
           WHERE r.source_node_id=$1 OR r.target_node_id=$1
           ORDER BY r.created_at DESC`,
          [node_id],
        ),
      ]);
      if (!node.rows[0]) return result({ error: "Knowledge node not found" });
      return result({ node: node.rows[0], versions: versions.rows, relations: relations.rows });
    },
  );

  server.registerTool(
    "get_project_tree",
    {
      description: "Return the complete project workflow + knowledge tree for deterministic hierarchy reconstruction.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
      }),
    },
    async ({ project_id }) => {
      const [workflows, nodes] = await Promise.all([
        pool.query(
          "SELECT id,name,slug,description,position FROM workflows WHERE project_id=$1 ORDER BY position,name",
          [project_id],
        ),
        pool.query(
          `SELECT id,workflow_id,parent_id,node_type,title,slug,summary,status,metadata,current_version,position,updated_at
           FROM knowledge_nodes
           WHERE project_id=$1
           ORDER BY position,title`,
          [project_id],
        ),
      ]);
      return result({ workflows: workflows.rows, nodes: nodes.rows });
    },
  );

  server.registerTool(
    "get_roadmap",
    {
      description: "Read roadmap items for a project, optionally filtered by status.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        status: z.string().trim().optional(),
      }),
    },
    async ({ project_id, status }) => {
      const q = await pool.query(
        `SELECT * FROM roadmap_items
         WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)
         ORDER BY position,created_at`,
        [project_id, status || null],
      );
      return result({ roadmap: q.rows });
    },
  );

  server.registerTool(
    "get_recent_changes",
    {
      description: "Read the chronological audit trail of project changes.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        limit: z.number().int().min(1).max(100).default(30),
      }),
    },
    async ({ project_id, limit }) => {
      const q = await pool.query(
        `SELECT id,entity_type,entity_id,action,title,details,actor,created_at
         FROM activity_log
         WHERE project_id=$1
         ORDER BY created_at DESC
         LIMIT $2`,
        [project_id, limit],
      );
      return result({ changes: q.rows });
    },
  );

  server.registerTool(
    "create_project",
    {
      description: "Create a new project and its default reusable workflows.",
      inputSchema: z.object({
        name: z.string().trim().min(1).max(180),
        description: z.string().max(4000).default(""),
      }),
    },
    async ({ name, description }) => {
      const project = await tx(async (client) => {
        const workspace = await client.query(
          "SELECT id FROM workspaces ORDER BY created_at LIMIT 1",
        );
        if (!workspace.rows[0]) throw new Error("Workspace is not initialized");

        const slug = `${slugify(name)}-${Date.now().toString(36)}`;
        const p = await client.query(
          `INSERT INTO projects(workspace_id,name,slug,description,accent)
           VALUES($1,$2,$3,$4,'#151A23')
           RETURNING *`,
          [workspace.rows[0].id, name, slug, description],
        );
        const projectRow = p.rows[0];
        const defaults = [
          ["Product", "product", "Vision, requirements and product decisions", 10],
          ["Engineering", "engineering", "Architecture, implementation and infrastructure", 20],
          ["Design", "design", "UX, UI and design system", 30],
          ["Operations", "operations", "Deployment, observability and runbooks", 40],
        ];
        for (const item of defaults) {
          await client.query(
            "INSERT INTO workflows(project_id,name,slug,description,position) VALUES($1,$2,$3,$4,$5)",
            [projectRow.id, ...item],
          );
        }
        await appendActivity(client, {
          projectId: projectRow.id,
          entityType: "project",
          entityId: projectRow.id,
          action: "created",
          title: `Project created: ${name}`,
          details: { source: "mcp" },
        });
        return projectRow;
      });
      return result({ project });
    },
  );

  server.registerTool(
    "create_workflow",
    {
      description: "Add a workflow to an existing project.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        name: z.string().trim().min(1).max(180),
        description: z.string().max(4000).default(""),
      }),
    },
    async ({ project_id, name, description }) => {
      const workflow = await tx(async (client) => {
        const max = await client.query(
          "SELECT coalesce(max(position),0)::int AS max FROM workflows WHERE project_id=$1",
          [project_id],
        );
        const slug = `${slugify(name)}-${Date.now().toString(36)}`;
        const r = await client.query(
          `INSERT INTO workflows(project_id,name,slug,description,position)
           VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [project_id, name, slug, description, max.rows[0].max + 10],
        );
        await appendActivity(client, {
          projectId: project_id,
          entityType: "workflow",
          entityId: r.rows[0].id,
          action: "created",
          title: `Workflow created: ${name}`,
          details: { slug },
        });
        return r.rows[0];
      });
      return result({ workflow });
    },
  );

  server.registerTool(
    "save_knowledge",
    {
      description:
        "Persist a new structured knowledge item. Use for approved decisions, architecture, requirements, research, runbooks, logs and durable project facts.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        workflow_id: z.string().uuid().nullable().optional(),
        parent_id: z.string().uuid().nullable().optional(),
        node_type: z.enum([
          "folder",
          "document",
          "decision",
          "architecture",
          "requirement",
          "research",
          "runbook",
          "log",
        ]).default("document"),
        title: z.string().trim().min(1).max(300),
        summary: z.string().max(6000).default(""),
        content: z.string().max(200000).default(""),
        status: z.string().trim().max(80).default("active"),
        change_note: z.string().max(4000).default("Created through MCP"),
        metadata: z.record(z.string(), z.unknown()).default({}),
      }),
    },
    async (input) => {
      const node = await tx(async (client) => {
        const slug = `${slugify(input.title)}-${Date.now().toString(36)}`;
        const max = await client.query(
          "SELECT coalesce(max(position),0)::int AS max FROM knowledge_nodes WHERE project_id=$1 AND parent_id IS NOT DISTINCT FROM $2",
          [input.project_id, input.parent_id || null],
        );
        const inserted = await client.query(
          `INSERT INTO knowledge_nodes(
            project_id,workflow_id,parent_id,node_type,title,slug,summary,content,status,metadata,current_version,position
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11)
           RETURNING *`,
          [
            input.project_id,
            input.workflow_id || null,
            input.parent_id || null,
            input.node_type,
            input.title,
            slug,
            input.summary,
            input.content,
            input.status,
            input.metadata,
            max.rows[0].max + 10,
          ],
        );
        const n = inserted.rows[0];
        await client.query(
          `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
           VALUES($1,1,$2,$3,$4,$5,$6,'mcp')`,
          [n.id, n.title, n.summary, n.content, n.metadata, input.change_note],
        );
        await appendActivity(client, {
          projectId: input.project_id,
          entityType: "knowledge",
          entityId: n.id,
          action: "created",
          title: `Created: ${n.title}`,
          details: { node_type: n.node_type, version: 1, change_note: input.change_note },
        });
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [input.project_id]);
        return n;
      });
      return result({ node });
    },
  );

  server.registerTool(
    "update_knowledge",
    {
      description:
        "Update an existing knowledge node. Every call creates an immutable version snapshot and audit-log event.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        title: z.string().trim().min(1).max(300).optional(),
        summary: z.string().max(6000).optional(),
        content: z.string().max(200000).optional(),
        status: z.string().trim().max(80).optional(),
        node_type: z.enum([
          "folder",
          "document",
          "decision",
          "architecture",
          "requirement",
          "research",
          "runbook",
          "log",
        ]).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        change_note: z.string().trim().min(1).max(4000),
      }),
    },
    async (input) => {
      const node = await tx(async (client) => {
        const current = await client.query(
          "SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",
          [input.node_id],
        );
        if (!current.rows[0]) return null;
        const c = current.rows[0];
        const version = c.current_version + 1;
        const values = {
          title: input.title ?? c.title,
          summary: input.summary ?? c.summary,
          content: input.content ?? c.content,
          status: input.status ?? c.status,
          node_type: input.node_type ?? c.node_type,
          metadata: input.metadata ?? c.metadata,
        };
        const updated = await client.query(
          `UPDATE knowledge_nodes
           SET title=$2,summary=$3,content=$4,status=$5,node_type=$6,metadata=$7,current_version=$8,updated_at=now()
           WHERE id=$1
           RETURNING *`,
          [
            input.node_id,
            values.title,
            values.summary,
            values.content,
            values.status,
            values.node_type,
            values.metadata,
            version,
          ],
        );
        const n = updated.rows[0];
        await client.query(
          `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
           VALUES($1,$2,$3,$4,$5,$6,$7,'mcp')`,
          [n.id, version, n.title, n.summary, n.content, n.metadata, input.change_note],
        );
        await appendActivity(client, {
          projectId: n.project_id,
          entityType: "knowledge",
          entityId: n.id,
          action: "updated",
          title: `Updated: ${n.title}`,
          details: { version, change_note: input.change_note },
        });
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [n.project_id]);
        return n;
      });
      if (!node) return result({ error: "Knowledge node not found" });
      return result({ node });
    },
  );

  server.registerTool(
    "update_workflow",
    {
      description:
        "Rename, describe or reorder a project workflow/category. Use this to maintain the top-level project taxonomy.",
      inputSchema: z.object({
        workflow_id: z.string().uuid(),
        name: z.string().trim().min(1).max(180).optional(),
        description: z.string().max(4000).optional(),
        position: z.number().int().min(0).max(100000).optional(),
      }),
    },
    async (input) => {
      const workflow = await tx(async (client) => {
        const current = await client.query(
          "SELECT * FROM workflows WHERE id=$1 FOR UPDATE",
          [input.workflow_id],
        );
        if (!current.rows[0]) return null;
        const w = current.rows[0];
        const updated = await client.query(
          `UPDATE workflows
           SET name=$2,description=$3,position=$4
           WHERE id=$1
           RETURNING *`,
          [
            input.workflow_id,
            input.name ?? w.name,
            input.description ?? w.description,
            input.position ?? w.position,
          ],
        );
        const next = updated.rows[0];
        await appendActivity(client, {
          projectId: next.project_id,
          entityType: "workflow",
          entityId: next.id,
          action: "updated",
          title: `Workflow updated: ${next.name}`,
          details: { previous_name: w.name, position: next.position },
        });
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [next.project_id]);
        return next;
      });
      if (!workflow) return result({ error: "Workflow not found" });
      return result({ workflow });
    },
  );

  server.registerTool(
    "move_knowledge",
    {
      description:
        "Move/re-parent a knowledge node to another branch or workflow and optionally reorder it. Prevents cross-project moves and tree cycles. Every structural move creates a version snapshot and audit event.",
      inputSchema: z.object({
        node_id: z.string().uuid(),
        parent_id: z.string().uuid().nullable().optional(),
        workflow_id: z.string().uuid().nullable().optional(),
        position: z.number().int().min(0).max(100000).optional(),
        change_note: z.string().trim().min(1).max(4000).default("Knowledge tree reorganized"),
      }),
    },
    async (input) => {
      const moved = await tx(async (client) => {
        const current = await client.query(
          "SELECT * FROM knowledge_nodes WHERE id=$1 FOR UPDATE",
          [input.node_id],
        );
        if (!current.rows[0]) return { error: "Knowledge node not found" };
        const n = current.rows[0];

        const nextParent = input.parent_id === undefined ? n.parent_id : input.parent_id;
        const nextWorkflow = input.workflow_id === undefined ? n.workflow_id : input.workflow_id;
        const nextPosition = input.position === undefined ? n.position : input.position;

        if (nextParent === input.node_id) return { error: "A node cannot be its own parent" };

        if (nextParent) {
          const parent = await client.query(
            "SELECT id,project_id FROM knowledge_nodes WHERE id=$1",
            [nextParent],
          );
          if (!parent.rows[0]) return { error: "Target parent not found" };
          if (parent.rows[0].project_id !== n.project_id) {
            return { error: "Cross-project moves are not allowed" };
          }
          const descendant = await client.query(
            `WITH RECURSIVE descendants AS (
               SELECT id FROM knowledge_nodes WHERE parent_id=$1
               UNION ALL
               SELECT child.id
               FROM knowledge_nodes child
               JOIN descendants d ON child.parent_id=d.id
             )
             SELECT 1 FROM descendants WHERE id=$2 LIMIT 1`,
            [input.node_id, nextParent],
          );
          if (descendant.rows[0]) {
            return { error: "Move rejected because it would create a tree cycle" };
          }
        }

        if (nextWorkflow) {
          const workflow = await client.query(
            "SELECT id,project_id FROM workflows WHERE id=$1",
            [nextWorkflow],
          );
          if (!workflow.rows[0]) return { error: "Target workflow not found" };
          if (workflow.rows[0].project_id !== n.project_id) {
            return { error: "Target workflow belongs to another project" };
          }
        }

        const version = n.current_version + 1;
        const updated = await client.query(
          `UPDATE knowledge_nodes
           SET parent_id=$2,workflow_id=$3,position=$4,current_version=$5,updated_at=now()
           WHERE id=$1
           RETURNING *`,
          [input.node_id, nextParent || null, nextWorkflow || null, nextPosition, version],
        );
        const next = updated.rows[0];

        await client.query(
          `INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
           VALUES($1,$2,$3,$4,$5,$6,$7,'mcp')`,
          [
            next.id,
            version,
            next.title,
            next.summary,
            next.content,
            {
              ...next.metadata,
              structure: {
                workflow_id: next.workflow_id,
                parent_id: next.parent_id,
                position: next.position,
              },
            },
            input.change_note,
          ],
        );

        await appendActivity(client, {
          projectId: next.project_id,
          entityType: "knowledge",
          entityId: next.id,
          action: "moved",
          title: `Moved: ${next.title}`,
          details: {
            version,
            from_parent_id: n.parent_id,
            to_parent_id: next.parent_id,
            from_workflow_id: n.workflow_id,
            to_workflow_id: next.workflow_id,
            position: next.position,
            change_note: input.change_note,
          },
        });
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [next.project_id]);
        return { node: next };
      });

      return result(moved);
    },
  );

  server.registerTool(
    "create_relation",
    {
      description:
        "Create an explicit typed relation between two knowledge nodes in the same project, such as depends_on, implements, replaces, related, blocks or supports.",
      inputSchema: z.object({
        source_node_id: z.string().uuid(),
        target_node_id: z.string().uuid(),
        relation_type: z.string().trim().min(1).max(80).default("related"),
      }),
    },
    async ({ source_node_id, target_node_id, relation_type }) => {
      const relation = await tx(async (client) => {
        if (source_node_id === target_node_id) return { error: "A node cannot relate to itself" };

        const nodes = await client.query(
          "SELECT id,project_id,title FROM knowledge_nodes WHERE id = ANY($1::uuid[])",
          [[source_node_id, target_node_id]],
        );
        if (nodes.rows.length !== 2) return { error: "One or both knowledge nodes were not found" };
        if (nodes.rows[0].project_id !== nodes.rows[1].project_id) {
          return { error: "Relations cannot cross projects" };
        }

        const projectId = nodes.rows[0].project_id;
        const inserted = await client.query(
          `INSERT INTO relations(project_id,source_node_id,target_node_id,relation_type)
           VALUES($1,$2,$3,$4)
           ON CONFLICT(source_node_id,target_node_id,relation_type)
           DO UPDATE SET relation_type=EXCLUDED.relation_type
           RETURNING *`,
          [projectId, source_node_id, target_node_id, relation_type],
        );
        await appendActivity(client, {
          projectId,
          entityType: "relation",
          entityId: inserted.rows[0].id,
          action: "created",
          title: `Knowledge relation: ${relation_type}`,
          details: { source_node_id, target_node_id, relation_type },
        });
        return { relation: inserted.rows[0] };
      });

      return result(relation);
    },
  );

  server.registerTool(
    "save_roadmap_item",
    {
      description: "Create a roadmap item linked to an optional workflow or parent roadmap item.",
      inputSchema: z.object({
        project_id: z.string().uuid(),
        workflow_id: z.string().uuid().nullable().optional(),
        parent_id: z.string().uuid().nullable().optional(),
        title: z.string().trim().min(1).max(300),
        description: z.string().max(10000).default(""),
        status: z.enum(["planned", "in_progress", "blocked", "done"]).default("planned"),
        priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
        progress: z.number().int().min(0).max(100).default(0),
        target_date: z.string().nullable().optional(),
      }),
    },
    async (input) => {
      const item = await tx(async (client) => {
        const max = await client.query(
          "SELECT coalesce(max(position),0)::int AS max FROM roadmap_items WHERE project_id=$1",
          [input.project_id],
        );
        const r = await client.query(
          `INSERT INTO roadmap_items(
            project_id,workflow_id,parent_id,title,description,status,priority,progress,target_date,position
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            input.project_id,
            input.workflow_id || null,
            input.parent_id || null,
            input.title,
            input.description,
            input.status,
            input.priority,
            input.progress,
            input.target_date || null,
            max.rows[0].max + 10,
          ],
        );
        const itemRow = r.rows[0];
        await appendActivity(client, {
          projectId: input.project_id,
          entityType: "roadmap",
          entityId: itemRow.id,
          action: "created",
          title: `Roadmap: ${itemRow.title}`,
          details: {
            status: itemRow.status,
            priority: itemRow.priority,
            progress: itemRow.progress,
          },
        });
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [input.project_id]);
        return itemRow;
      });
      return result({ item });
    },
  );

  server.registerTool(
    "update_roadmap_item",
    {
      description: "Update roadmap execution state and record the change in the project audit trail.",
      inputSchema: z.object({
        item_id: z.string().uuid(),
        status: z.enum(["planned", "in_progress", "blocked", "done"]).optional(),
        priority: z.enum(["low", "medium", "high", "critical"]).optional(),
        progress: z.number().int().min(0).max(100).optional(),
        description: z.string().max(10000).optional(),
        target_date: z.string().nullable().optional(),
      }),
    },
    async (input) => {
      const item = await tx(async (client) => {
        const current = await client.query(
          "SELECT * FROM roadmap_items WHERE id=$1 FOR UPDATE",
          [input.item_id],
        );
        if (!current.rows[0]) return null;
        const c = current.rows[0];
        const updated = await client.query(
          `UPDATE roadmap_items
           SET status=$2,priority=$3,progress=$4,description=$5,target_date=$6,updated_at=now()
           WHERE id=$1
           RETURNING *`,
          [
            input.item_id,
            input.status ?? c.status,
            input.priority ?? c.priority,
            input.progress ?? c.progress,
            input.description ?? c.description,
            input.target_date === undefined ? c.target_date : input.target_date,
          ],
        );
        const itemRow = updated.rows[0];
        await appendActivity(client, {
          projectId: itemRow.project_id,
          entityType: "roadmap",
          entityId: itemRow.id,
          action: "updated",
          title: `Roadmap updated: ${itemRow.title}`,
          details: {
            status: itemRow.status,
            priority: itemRow.priority,
            progress: itemRow.progress,
          },
        });
        await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [itemRow.project_id]);
        return itemRow;
      });
      if (!item) return result({ error: "Roadmap item not found" });
      return result({ item });
    },
  );

  return server;
}, { responseMode: "json" });

const nodeHandler = toNodeHandler(handler);

function hostAllowed(req) {
  const hostname = String(req.headers.host || "").split(":")[0].toLowerCase();
  const publicHost = String(process.env.PRBRAIN_PUBLIC_HOST || "").trim().toLowerCase();
  return hostname === "127.0.0.1" || hostname === "localhost" || (publicHost && hostname === publicHost);
}

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "pr-brain-mcp" }));
    return;
  }

  if (!req.url?.startsWith("/mcp")) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  const token = process.env.PRBRAIN_MCP_TOKEN;
  const authorization = req.headers.authorization || "";
  if (!token || authorization !== `Bearer ${token}`) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (!hostAllowed(req)) {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "Host not allowed" }));
    return;
  }

  void nodeHandler(req, res);
});

const port = Number(process.env.PRBRAIN_MCP_PORT || 3001);
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`PR Brain MCP listening on :${port}/mcp`);
});

async function shutdown() {
  await handler.close();
  await pool.end();
  httpServer.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
