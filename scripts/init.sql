CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  accent text NOT NULL DEFAULT '#111827',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, slug)
);

CREATE TABLE IF NOT EXISTS knowledge_nodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  node_type text NOT NULL DEFAULT 'document',
  title text NOT NULL,
  slug text NOT NULL,
  summary text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  current_version integer NOT NULL DEFAULT 1,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, slug)
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id bigserial PRIMARY KEY,
  node_id uuid NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  version integer NOT NULL,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  content text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note text NOT NULL DEFAULT '',
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(node_id, version)
);

CREATE TABLE IF NOT EXISTS roadmap_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  workflow_id uuid REFERENCES workflows(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES roadmap_items(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'planned',
  priority text NOT NULL DEFAULT 'medium',
  progress integer NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  target_date date,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS activity_log (
  id bigserial PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id uuid,
  action text NOT NULL,
  title text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_node_id uuid NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  target_node_id uuid NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  relation_type text NOT NULL DEFAULT 'related',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_node_id, target_node_id, relation_type)
);

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  UNIQUE(workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS node_tags (
  node_id uuid NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY(node_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_nodes_project ON knowledge_nodes(project_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON knowledge_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_workflow ON knowledge_nodes(workflow_id);
CREATE INDEX IF NOT EXISTS idx_nodes_updated ON knowledge_nodes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_roadmap_project ON roadmap_items(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project_time ON activity_log(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_search ON knowledge_nodes USING gin (
  to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(content,''))
);

DO $$
DECLARE
  ws uuid;
  pr uuid;
  product_wf uuid;
  eng_wf uuid;
  design_wf uuid;
  ops_wf uuid;
  root_node uuid;
  arch_node uuid;
  memory_node uuid;
BEGIN
  SELECT id INTO ws FROM workspaces WHERE slug='main';
  IF ws IS NULL THEN
    INSERT INTO workspaces(name, slug) VALUES ('Main Workspace','main') RETURNING id INTO ws;
  END IF;

  SELECT id INTO pr FROM projects WHERE workspace_id=ws AND slug='pr-brain';
  IF pr IS NULL THEN
    INSERT INTO projects(workspace_id,name,slug,description,accent)
    VALUES (ws,'PR Brain','pr-brain','Project memory, workflow, roadmap and change intelligence workspace.','#151A23')
    RETURNING id INTO pr;

    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (pr,'Product','product','Vision, requirements and product decisions',10)
    RETURNING id INTO product_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (pr,'Engineering','engineering','Architecture, backend, frontend and infrastructure',20)
    RETURNING id INTO eng_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (pr,'Design','design','UX, UI system and interaction rules',30)
    RETURNING id INTO design_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (pr,'Operations','operations','Deployment, observability, backups and runbooks',40)
    RETURNING id INTO ops_wf;

    INSERT INTO knowledge_nodes(project_id,workflow_id,node_type,title,slug,summary,content,position)
    VALUES (pr,product_wf,'folder','Project Definition','project-definition','Core scope and operating principles',
      'PR Brain is a self-hosted system of record for multiple projects. Projects contain reusable workflows, deeply nested knowledge, roadmap items, decisions, implementation history and context packs.',10)
    RETURNING id INTO root_node;

    INSERT INTO knowledge_nodes(project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position)
    VALUES (pr,eng_wf,NULL,'architecture','System Architecture','system-architecture','Core application architecture',
      'The first production slice uses Next.js, PostgreSQL and Docker. Knowledge is stored as versioned tree nodes. Every material write produces an immutable version and an activity event. Search combines PostgreSQL full-text search with deterministic filters.',
      '{"state":"accepted","owner":"engineering"}',10)
    RETURNING id INTO arch_node;

    INSERT INTO knowledge_nodes(project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position)
    VALUES (pr,eng_wf,arch_node,'document','Memory Model','memory-model','How project memory is represented',
      'Memory is organized by Workspace → Project → Workflow → Knowledge Tree. Nodes may represent documents, folders, decisions, architecture records, requirements, research, runbooks or logs. Each node has immutable version history and can be related to other nodes.',
      '{"state":"accepted"}',20)
    RETURNING id INTO memory_node;

    INSERT INTO knowledge_nodes(project_id,workflow_id,node_type,title,slug,summary,content,metadata,position)
    VALUES (pr,design_wf,'decision','Interface Direction','interface-direction','Calm professional workspace, not an AI dashboard',
      'The UI follows a dense but calm workspace pattern: compact navigation, clear information hierarchy, strong typography, restrained surfaces and contextual detail panes. No neon AI visual language, chat bubbles or decorative gradients.',
      '{"state":"accepted"}',10);

    INSERT INTO roadmap_items(project_id,workflow_id,title,description,status,priority,progress,position)
    VALUES
      (pr,eng_wf,'Core knowledge engine','Versioned tree, search, activity and context APIs','in_progress','high',75,10),
      (pr,product_wf,'Workflow templates','Reusable workflow templates assignable to any project','planned','high',20,20),
      (pr,ops_wf,'Backups & restore','Automated PostgreSQL backup and tested restore procedure','planned','high',0,30),
      (pr,eng_wf,'MCP connector','Read/write tool surface for ChatGPT and other clients','planned','high',10,40);

    INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
    VALUES
      (pr,'project',pr,'created','PR Brain workspace initialized','{"source":"bootstrap"}','system'),
      (pr,'knowledge',arch_node,'created','System architecture recorded','{"version":1}','system'),
      (pr,'knowledge',memory_node,'created','Memory model recorded','{"version":1}','system');

    INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
    SELECT id,1,title,summary,content,metadata,'Initial version','system'
    FROM knowledge_nodes WHERE project_id=pr;
  END IF;
END $$;
