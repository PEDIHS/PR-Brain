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



DO $$
DECLARE
  ws uuid;
  tak_project uuid;
  product_wf uuid;
  engineering_wf uuid;
  design_wf uuid;
  business_wf uuid;
  marketing_wf uuid;
  research_wf uuid;
  operations_wf uuid;
  brand_wf uuid;
  definition_node uuid;
  positioning_node uuid;
  inventory_node uuid;
  search_node uuid;
  architecture_node uuid;
  supply_node uuid;
  brand_node uuid;
BEGIN
  SELECT id INTO ws FROM workspaces WHERE slug='main';
  SELECT id INTO tak_project FROM projects WHERE workspace_id=ws AND slug='taktook';

  IF tak_project IS NULL THEN
    INSERT INTO projects(workspace_id,name,slug,description,accent)
    VALUES (
      ws,
      'TAKTOOK',
      'taktook',
      'Marketplace and inventory-intelligence platform for automotive parts, focused on making hard-to-find inventory searchable and comparable.',
      '#145C55'
    )
    RETURNING id INTO tak_project;

    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Product','product','Product definition, user flows, requirements and product decisions',10)
    RETURNING id INTO product_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Engineering','engineering','Architecture, services, data models, APIs, search and infrastructure',20)
    RETURNING id INTO engineering_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'UI & UX','ui-ux','Information architecture, interaction patterns and design system',30)
    RETURNING id INTO design_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Business','business','Business model, supply strategy, trust layer and monetization',40)
    RETURNING id INTO business_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Marketing','marketing','Go-to-market, acquisition, SEO, campaigns and measurement',50)
    RETURNING id INTO marketing_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Research','research','Market, competitor, user and technical research',60)
    RETURNING id INTO research_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Operations','operations','Seller operations, support, deployment, monitoring and runbooks',70)
    RETURNING id INTO operations_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (tak_project,'Brand','brand','Brand identity, naming, messaging and visual language',80)
    RETURNING id INTO brand_wf;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,product_wf,'folder','Project Definition','project-definition',
      'The durable definition of what TAKTOOK is and what problem it solves.',
      'TAKTOOK is designed as more than an online parts store. The core product is a searchable network of automotive-parts inventory across sellers and cities, combined with compatibility intelligence, price and availability comparison, hard-to-find part requests, and eventually trust and transaction layers.',
      '{"state":"accepted","importance":"core"}',10
    ) RETURNING id INTO definition_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,product_wf,definition_node,'decision','Product Positioning','product-positioning',
      'Search engine + inventory network + marketplace, rather than a conventional catalog store.',
      'The product should be positioned around finding real inventory: what part exists, for which vehicle, with which seller, in which city, and at what price. Marketplace transactions are important, but inventory intelligence and discovery are the differentiating foundation.',
      '{"state":"accepted","decision_type":"product"}',20
    ) RETURNING id INTO positioning_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,product_wf,definition_node,'requirement','Seller Inventory Network','seller-inventory-network',
      'Digitize and synchronize seller and dismantler inventory into one searchable network.',
      'TAKTOOK should support structured inventory from automotive-parts sellers, used-parts sellers and dismantlers. A lightweight inventory/POS workflow can reduce onboarding friction and become a direct inventory feed. Inventory should retain seller, city, condition, vehicle compatibility, identifiers, availability and price context.',
      '{"state":"accepted","domain":"inventory"}',30
    ) RETURNING id INTO inventory_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,product_wf,definition_node,'requirement','Part Search & Compatibility','part-search-compatibility',
      'Search by part identity and determine vehicle compatibility.',
      'Search requirements include part name, OEM/part number and vehicle identifiers such as VIN where data is available. The compatibility layer should model interchangeable parts and relationships between parts and vehicle variants so discovery is not limited to exact text matching.',
      '{"state":"accepted","domain":"search"}',40
    ) RETURNING id INTO search_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,engineering_wf,'architecture','Architecture Drivers','architecture-drivers',
      'Capabilities the technical architecture must preserve as the implementation evolves.',
      'The architecture must support seller inventory ingestion and synchronization, structured vehicle/part compatibility, high-quality search, multi-city availability and pricing, part-request/quote flows, auditability, and future trust/transaction capabilities. Technical choices may evolve; these capabilities are architectural constraints.',
      '{"state":"accepted","owner":"engineering"}',10
    ) RETURNING id INTO architecture_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,business_wf,'document','Supply-Side Strategy','supply-side-strategy',
      'Create value for sellers while building the inventory data moat.',
      'Seller acquisition is not only a listing problem. TAKTOOK can create utility through simple inventory management and structured cataloging, then use those feeds to keep marketplace availability current. Used-parts sellers and dismantlers are especially important for hard-to-find inventory.',
      '{"state":"active","domain":"supply"}',10
    ) RETURNING id INTO supply_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      tak_project,brand_wf,'decision','Brand Foundation','brand-foundation',
      'TAKTOOK is the project brand; messaging emphasizes items that are uncommon or difficult to find.',
      'Brand name: TAKTOOK / تک‌وتوک. Domain discussed for the project: taktook.ir. The naming idea fits the product promise of finding uncommon or hard-to-find items. Working message directions have included «سخت‌پیداها اینجان» and «هرچی همه‌جا نیست»; these should remain working copy until explicitly locked.',
      '{"state":"accepted","copy_status":"working"}',10
    ) RETURNING id INTO brand_node;

    INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
    SELECT id,1,title,summary,content,metadata,'Imported as initial project memory','system'
    FROM knowledge_nodes
    WHERE knowledge_nodes.project_id=tak_project;

    INSERT INTO roadmap_items(
      project_id,workflow_id,title,description,status,priority,progress,position
    ) VALUES
      (tak_project,product_wf,'Lock MVP scope','Define the smallest end-to-end buyer + seller loop and explicit non-goals.','in_progress','high',35,10),
      (tak_project,engineering_wf,'Canonical vehicle & part data model','Model vehicles, variants, parts, identifiers, compatibility and interchangeable parts.','planned','critical',10,20),
      (tak_project,engineering_wf,'Inventory ingestion MVP','Create the first seller inventory import/sync path with traceable updates.','planned','high',5,30),
      (tak_project,engineering_wf,'Search & compatibility MVP','Implement search across part text/identifiers and compatibility relationships.','planned','critical',5,40),
      (tak_project,business_wf,'Seller onboarding pilot','Validate the supply workflow with a small real seller cohort.','planned','high',0,50),
      (tak_project,business_wf,'Trust & transaction design','Define verification, test/return expectations and transaction protections.','planned','medium',0,60),
      (tak_project,marketing_wf,'Demand acquisition baseline','Define SEO/category landing structure and measurable acquisition baseline.','planned','medium',0,70);

    INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
    VALUES
      (tak_project,'project',tak_project,'created','TAKTOOK project memory initialized','{"source":"bootstrap-import"}','system'),
      (tak_project,'knowledge',positioning_node,'created','Product positioning imported','{"version":1}','system'),
      (tak_project,'knowledge',inventory_node,'created','Inventory network requirement imported','{"version":1}','system'),
      (tak_project,'knowledge',search_node,'created','Search and compatibility requirement imported','{"version":1}','system'),
      (tak_project,'knowledge',architecture_node,'created','Architecture drivers imported','{"version":1}','system'),
      (tak_project,'knowledge',brand_node,'created','Brand foundation imported','{"version":1}','system');
  END IF;
END $$;


-- Project operational profile: fast machine-readable entrypoint for humans and agents.
CREATE TABLE IF NOT EXISTS project_profiles (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  primary_domain text NOT NULL DEFAULT '',
  repository_url text NOT NULL DEFAULT '',
  default_branch text NOT NULL DEFAULT 'main',
  server_host text NOT NULL DEFAULT '',
  server_alias text NOT NULL DEFAULT '',
  deploy_path text NOT NULL DEFAULT '',
  web_root text NOT NULL DEFAULT '',
  env_path text NOT NULL DEFAULT '',
  compose_path text NOT NULL DEFAULT '',
  runtime text NOT NULL DEFAULT '',
  healthcheck_url text NOT NULL DEFAULT '',
  readme_md text NOT NULL DEFAULT '',
  agent_rules_md text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind text NOT NULL,
  name text NOT NULL,
  value text NOT NULL,
  environment text NOT NULL DEFAULT 'production',
  is_primary boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, kind, name, environment)
);

CREATE INDEX IF NOT EXISTS idx_project_resources_project_kind
  ON project_resources(project_id, kind, environment);

INSERT INTO project_profiles(
  project_id,primary_domain,repository_url,default_branch,server_host,server_alias,
  deploy_path,web_root,env_path,compose_path,runtime,healthcheck_url,readme_md,agent_rules_md,metadata
)
SELECT
  p.id,
  'brain.pedramhs.ir',
  'https://github.com/PEDIHS/PR-Brain',
  'main',
  '46.8.100.224',
  'pedram2',
  '/opt/pr-brain',
  '/opt/pr-brain',
  '/opt/pr-brain/.env',
  '/opt/pr-brain/docker-compose.yml',
  'Docker Compose · Next.js · PostgreSQL · MCP',
  'https://brain.pedramhs.ir/api/health',
  '# PR Brain

## Purpose
PR Brain is the structured source of truth for multiple projects. It stores project profiles, workflow trees, durable knowledge, decisions, roadmap state, versions and change history.

## Production
- Web: https://brain.pedramhs.ir
- MCP: https://brain.pedramhs.ir/mcp
- Repository: https://github.com/PEDIHS/PR-Brain
- Branch: main
- Server: 46.8.100.224
- Server alias: pedram2
- Deploy path: /opt/pr-brain
- Docker Compose: /opt/pr-brain/docker-compose.yml
- Environment file: /opt/pr-brain/.env
- Health: https://brain.pedramhs.ir/api/health

## Runtime services
- prbrain-app: Next.js web application
- prbrain-mcp: MCP gateway for agents
- prbrain-db: PostgreSQL source of truth

## Agent entry
Agents should call open_project with pr-brain before substantial work, inspect the profile and rules, then use the structured write tools so changes remain versioned and auditable.',
  '# Agent rules
1. Read the project profile before making structural or deployment changes.
2. Never expose secrets or copy .env contents into knowledge nodes.
3. Durable decisions must be stored as decision or architecture nodes.
4. Structural moves must use move_knowledge so cycle protection and audit logging are preserved.
5. Every material implementation change should leave an activity trace or knowledge update.
6. Prefer superseding old decisions over deleting historical context.',
  '{"profile_version":1,"source":"system-seed"}'::jsonb
FROM projects p
WHERE p.slug='pr-brain'
ON CONFLICT(project_id) DO UPDATE SET
  primary_domain=EXCLUDED.primary_domain,
  repository_url=EXCLUDED.repository_url,
  default_branch=EXCLUDED.default_branch,
  server_host=EXCLUDED.server_host,
  server_alias=EXCLUDED.server_alias,
  deploy_path=EXCLUDED.deploy_path,
  web_root=EXCLUDED.web_root,
  env_path=EXCLUDED.env_path,
  compose_path=EXCLUDED.compose_path,
  runtime=EXCLUDED.runtime,
  healthcheck_url=EXCLUDED.healthcheck_url,
  readme_md=CASE WHEN project_profiles.readme_md='' THEN EXCLUDED.readme_md ELSE project_profiles.readme_md END,
  agent_rules_md=CASE WHEN project_profiles.agent_rules_md='' THEN EXCLUDED.agent_rules_md ELSE project_profiles.agent_rules_md END,
  metadata=project_profiles.metadata || EXCLUDED.metadata,
  updated_at=now();

INSERT INTO project_profiles(
  project_id,primary_domain,repository_url,default_branch,runtime,readme_md,agent_rules_md,metadata
)
SELECT
  p.id,
  'taktook.ir',
  '',
  'main',
  'Not yet bound to a production runtime in PR Brain',
  '# TAKTOOK

## Purpose
TAKTOOK is an automotive-parts inventory intelligence and marketplace project focused on making hard-to-find inventory searchable, comparable and trustworthy.

## Product shape
The durable product direction is: search engine + live inventory network + marketplace. Core domains include seller inventory, vehicle/part compatibility, OEM/part identifiers, multi-city availability and price comparison, buy requests/quotes and later trust/transaction layers.

## Operational profile
- Primary brand/domain: taktook.ir
- Production repository: not registered yet
- Production server/path: not registered yet

## Workflows
Product, Engineering, UI & UX, Business, Marketing, Research, Operations and Brand.

## Agent entry
Agents should call open_project with TAKTOOK before work. Treat accepted decisions and architecture nodes as current truth unless a newer node explicitly supersedes them.',
  '# Agent rules
1. Resolve TAKTOOK through open_project before substantial work.
2. Do not invent repository, server or deployment paths; register them only when verified.
3. New durable product facts belong in Product; technical implementation truth belongs in Engineering.
4. Accepted decisions must be superseded explicitly rather than silently overwritten.
5. Link dependent concepts with relations when a change can affect another subsystem.
6. Keep roadmap state synchronized with implementation evidence.',
  '{"profile_version":1,"source":"system-seed","deployment_status":"unregistered"}'::jsonb
FROM projects p
WHERE p.slug='taktook'
ON CONFLICT(project_id) DO UPDATE SET
  primary_domain=CASE WHEN project_profiles.primary_domain='' THEN EXCLUDED.primary_domain ELSE project_profiles.primary_domain END,
  readme_md=CASE WHEN project_profiles.readme_md='' THEN EXCLUDED.readme_md ELSE project_profiles.readme_md END,
  agent_rules_md=CASE WHEN project_profiles.agent_rules_md='' THEN EXCLUDED.agent_rules_md ELSE project_profiles.agent_rules_md END,
  metadata=project_profiles.metadata || EXCLUDED.metadata,
  updated_at=now();

INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'domain','web','https://brain.pedramhs.ir','production',true,'{}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'endpoint','mcp','https://brain.pedramhs.ir/mcp','production',true,'{"auth":"bearer"}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'repository','github','https://github.com/PEDIHS/PR-Brain','production',true,'{"branch":"main"}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'server','production','46.8.100.224','production',true,'{"alias":"pedram2"}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'path','deploy','/opt/pr-brain','production',true,'{}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'path','env','/opt/pr-brain/.env','production',false,'{"secret":true}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'path','compose','/opt/pr-brain/docker-compose.yml','production',false,'{}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'service','web','prbrain-app','production',true,'{"internal_port":3000,"loopback_port":18250}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'service','mcp','prbrain-mcp','production',true,'{"internal_port":3001,"loopback_port":18251}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();
INSERT INTO project_resources(project_id,kind,name,value,environment,is_primary,metadata)
SELECT p.id,'service','database','prbrain-db','production',true,'{"engine":"PostgreSQL 16"}'::jsonb FROM projects p WHERE p.slug='pr-brain'
ON CONFLICT(project_id,kind,name,environment) DO UPDATE SET value=EXCLUDED.value,is_primary=EXCLUDED.is_primary,metadata=EXCLUDED.metadata,updated_at=now();


-- MCP / Agent usage telemetry. Stores operational call metadata only; never stores secrets or full content.
CREATE TABLE IF NOT EXISTS mcp_usage_log (
  id bigserial PRIMARY KEY,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  tool_name text NOT NULL,
  agent_name text NOT NULL DEFAULT 'unknown',
  user_agent text NOT NULL DEFAULT '',
  request_id text NOT NULL DEFAULT '',
  success boolean NOT NULL DEFAULT true,
  duration_ms integer NOT NULL DEFAULT 0,
  input_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_usage_time ON mcp_usage_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_project_time ON mcp_usage_log(project_id,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_agent_time ON mcp_usage_log(agent_name,created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_usage_tool_time ON mcp_usage_log(tool_name,created_at DESC);


-- Durable project snapshots for safe agent-led change batches and rollback inspection.
CREATE TABLE IF NOT EXISTS project_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  snapshot jsonb NOT NULL,
  created_by text NOT NULL DEFAULT 'mcp',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_snapshots_project_time
  ON project_snapshots(project_id, created_at DESC);


-- GitOps synchronization ledger. Each applied GitHub changeset is immutable by repo/path/blob SHA.
CREATE TABLE IF NOT EXISTS github_sync_applied (
  id bigserial PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repository text NOT NULL,
  git_ref text NOT NULL DEFAULT 'main',
  file_path text NOT NULL,
  blob_sha text NOT NULL,
  change_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  operation_count integer NOT NULL DEFAULT 0,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  applied_by text NOT NULL DEFAULT 'panel',
  applied_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(repository,file_path,blob_sha)
);

CREATE INDEX IF NOT EXISTS idx_github_sync_project_time
  ON github_sync_applied(project_id,applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_github_sync_change_id
  ON github_sync_applied(change_id);
