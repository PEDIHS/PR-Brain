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
  project_id uuid;
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
  SELECT id INTO project_id FROM projects WHERE workspace_id=ws AND slug='taktook';

  IF project_id IS NULL THEN
    INSERT INTO projects(workspace_id,name,slug,description,accent)
    VALUES (
      ws,
      'TAKTOOK',
      'taktook',
      'Marketplace and inventory-intelligence platform for automotive parts, focused on making hard-to-find inventory searchable and comparable.',
      '#145C55'
    )
    RETURNING id INTO project_id;

    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Product','product','Product definition, user flows, requirements and product decisions',10)
    RETURNING id INTO product_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Engineering','engineering','Architecture, services, data models, APIs, search and infrastructure',20)
    RETURNING id INTO engineering_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'UI & UX','ui-ux','Information architecture, interaction patterns and design system',30)
    RETURNING id INTO design_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Business','business','Business model, supply strategy, trust layer and monetization',40)
    RETURNING id INTO business_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Marketing','marketing','Go-to-market, acquisition, SEO, campaigns and measurement',50)
    RETURNING id INTO marketing_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Research','research','Market, competitor, user and technical research',60)
    RETURNING id INTO research_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Operations','operations','Seller operations, support, deployment, monitoring and runbooks',70)
    RETURNING id INTO operations_wf;
    INSERT INTO workflows(project_id,name,slug,description,position)
    VALUES (project_id,'Brand','brand','Brand identity, naming, messaging and visual language',80)
    RETURNING id INTO brand_wf;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,product_wf,'folder','Project Definition','project-definition',
      'The durable definition of what TAKTOOK is and what problem it solves.',
      'TAKTOOK is designed as more than an online parts store. The core product is a searchable network of automotive-parts inventory across sellers and cities, combined with compatibility intelligence, price and availability comparison, hard-to-find part requests, and eventually trust and transaction layers.',
      '{"state":"accepted","importance":"core"}',10
    ) RETURNING id INTO definition_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,product_wf,definition_node,'decision','Product Positioning','product-positioning',
      'Search engine + inventory network + marketplace, rather than a conventional catalog store.',
      'The product should be positioned around finding real inventory: what part exists, for which vehicle, with which seller, in which city, and at what price. Marketplace transactions are important, but inventory intelligence and discovery are the differentiating foundation.',
      '{"state":"accepted","decision_type":"product"}',20
    ) RETURNING id INTO positioning_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,product_wf,definition_node,'requirement','Seller Inventory Network','seller-inventory-network',
      'Digitize and synchronize seller and dismantler inventory into one searchable network.',
      'TAKTOOK should support structured inventory from automotive-parts sellers, used-parts sellers and dismantlers. A lightweight inventory/POS workflow can reduce onboarding friction and become a direct inventory feed. Inventory should retain seller, city, condition, vehicle compatibility, identifiers, availability and price context.',
      '{"state":"accepted","domain":"inventory"}',30
    ) RETURNING id INTO inventory_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,parent_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,product_wf,definition_node,'requirement','Part Search & Compatibility','part-search-compatibility',
      'Search by part identity and determine vehicle compatibility.',
      'Search requirements include part name, OEM/part number and vehicle identifiers such as VIN where data is available. The compatibility layer should model interchangeable parts and relationships between parts and vehicle variants so discovery is not limited to exact text matching.',
      '{"state":"accepted","domain":"search"}',40
    ) RETURNING id INTO search_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,engineering_wf,'architecture','Architecture Drivers','architecture-drivers',
      'Capabilities the technical architecture must preserve as the implementation evolves.',
      'The architecture must support seller inventory ingestion and synchronization, structured vehicle/part compatibility, high-quality search, multi-city availability and pricing, part-request/quote flows, auditability, and future trust/transaction capabilities. Technical choices may evolve; these capabilities are architectural constraints.',
      '{"state":"accepted","owner":"engineering"}',10
    ) RETURNING id INTO architecture_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,business_wf,'document','Supply-Side Strategy','supply-side-strategy',
      'Create value for sellers while building the inventory data moat.',
      'Seller acquisition is not only a listing problem. TAKTOOK can create utility through simple inventory management and structured cataloging, then use those feeds to keep marketplace availability current. Used-parts sellers and dismantlers are especially important for hard-to-find inventory.',
      '{"state":"active","domain":"supply"}',10
    ) RETURNING id INTO supply_node;

    INSERT INTO knowledge_nodes(
      project_id,workflow_id,node_type,title,slug,summary,content,metadata,position
    ) VALUES (
      project_id,brand_wf,'decision','Brand Foundation','brand-foundation',
      'TAKTOOK is the project brand; messaging emphasizes items that are uncommon or difficult to find.',
      'Brand name: TAKTOOK / تک‌وتوک. Domain discussed for the project: taktook.ir. The naming idea fits the product promise of finding uncommon or hard-to-find items. Working message directions have included «سخت‌پیداها اینجان» and «هرچی همه‌جا نیست»; these should remain working copy until explicitly locked.',
      '{"state":"accepted","copy_status":"working"}',10
    ) RETURNING id INTO brand_node;

    INSERT INTO knowledge_versions(node_id,version,title,summary,content,metadata,change_note,actor)
    SELECT id,1,title,summary,content,metadata,'Imported as initial project memory','system'
    FROM knowledge_nodes
    WHERE project_id=project_id;

    INSERT INTO roadmap_items(
      project_id,workflow_id,title,description,status,priority,progress,position
    ) VALUES
      (project_id,product_wf,'Lock MVP scope','Define the smallest end-to-end buyer + seller loop and explicit non-goals.','in_progress','high',35,10),
      (project_id,engineering_wf,'Canonical vehicle & part data model','Model vehicles, variants, parts, identifiers, compatibility and interchangeable parts.','planned','critical',10,20),
      (project_id,engineering_wf,'Inventory ingestion MVP','Create the first seller inventory import/sync path with traceable updates.','planned','high',5,30),
      (project_id,engineering_wf,'Search & compatibility MVP','Implement search across part text/identifiers and compatibility relationships.','planned','critical',5,40),
      (project_id,business_wf,'Seller onboarding pilot','Validate the supply workflow with a small real seller cohort.','planned','high',0,50),
      (project_id,business_wf,'Trust & transaction design','Define verification, test/return expectations and transaction protections.','planned','medium',0,60),
      (project_id,marketing_wf,'Demand acquisition baseline','Define SEO/category landing structure and measurable acquisition baseline.','planned','medium',0,70);

    INSERT INTO activity_log(project_id,entity_type,entity_id,action,title,details,actor)
    VALUES
      (project_id,'project',project_id,'created','TAKTOOK project memory initialized','{"source":"bootstrap-import"}','system'),
      (project_id,'knowledge',positioning_node,'created','Product positioning imported','{"version":1}','system'),
      (project_id,'knowledge',inventory_node,'created','Inventory network requirement imported','{"version":1}','system'),
      (project_id,'knowledge',search_node,'created','Search and compatibility requirement imported','{"version":1}','system'),
      (project_id,'knowledge',architecture_node,'created','Architecture drivers imported','{"version":1}','system'),
      (project_id,'knowledge',brand_node,'created','Brand foundation imported','{"version":1}','system');
  END IF;
END $$;
