---
name: use-pr-brain
description: >
  Use PR Brain as the durable source of truth and mutation API for projects.
  Invoke this skill whenever the user asks to continue, inspect, organize, document,
  change, plan, audit, or reason about a project that exists in PR Brain, including
  project structure, workflows, architecture, decisions, roadmap, resources,
  repositories, domains, servers, deployment paths, change history, knowledge graphs,
  agent usage, snapshots, or coordinated multi-entity changes.
---

# Use PR Brain

PR Brain is a persistent project memory and control plane exposed through a remote MCP server.

## Core operating rule

For substantial project work, start with:

1. `open_project(project)`
2. If the target entity is only known by a human name, use `resolve_entity()`.
3. Before material structural or architectural changes, use `get_project_health()`, `impact_analysis()`, or `search_project_everything()` as appropriate.
4. Use precise mutation tools for isolated edits.
5. For coordinated changes across several project entities, first call `apply_project_patch(..., dry_run=true)`.
6. If the dry-run is correct, commit with `dry_run=false`.
7. For risky/large batches, keep `create_snapshot_before=true`.
8. Verify the result with a read-back or `query_change_history()`.

## Project selection

Never assume the current project from unrelated context. Resolve it explicitly through `open_project`.

Projects are isolated. Never move a node, workflow, resource, relation or roadmap item across projects unless a dedicated future API explicitly supports that behavior.

## Knowledge rules

Use these node types consistently:

- `folder`: hierarchy only.
- `document`: durable documentation.
- `decision`: an explicit project/product/technical decision.
- `architecture`: architecture and system-design truth.
- `requirement`: required behavior, constraint or acceptance condition.
- `research`: research findings or evidence.
- `runbook`: operational procedures.
- `log`: durable operational/project log entry.

For durable knowledge:
- Prefer updating an existing stable node over creating duplicates.
- Use `upsert_knowledge` with a stable slug when possible.
- Use `expected_version` for important concurrent edits.
- Preserve historical truth; archive/supersede rather than erasing useful context.
- Use `diff_knowledge_versions` when the reason for a change matters.

## Workflow rules

Agents may create and update workflows.

Use:
- `create_workflow` for a single workflow.
- `update_workflow` for rename/description/order changes.
- `apply_project_patch` with `workflow.create` / `workflow.update` when the workflow is part of a larger coordinated change.

Do not create overlapping workflows casually. Search/resolve existing workflows first.

## Relations and impact

Use explicit relations for meaningful dependencies:

- `depends_on`
- `implements`
- `replaces`
- `blocks`
- `supports`
- `related`

Before changing a core architecture, decision or requirement node, call `impact_analysis` when downstream effects may exist.

## Roadmap rules

Keep roadmap state aligned with evidence.

A roadmap item should have:
- clear title,
- meaningful description,
- status,
- priority,
- progress,
- workflow when applicable.

Do not mark work complete only because a plan exists. Update status after implementation evidence is available.

## Operational profile and resources

Project locations are structured data, not prose guesses.

Use:
- `get_project_profile`
- `resolve_project_location`
- `update_project_profile`
- `upsert_project_resource`
- `delete_project_resource`

Never invent a repository URL, server IP, deploy path, domain, service name, database, or environment path.

Never store secrets or raw credentials in PR Brain knowledge. Secret paths may be recorded; secret values must not be.

## Atomic changes

`apply_project_patch` is the preferred API for coordinated changes.

Supported operation families include:
- project
- workflow
- knowledge
- roadmap
- relation
- resource

Create operations may define `ref`, and later operations can reference that ID with `$ref`.

Example pattern:

```
workflow.create ref=backend
knowledge.create workflow_id=$backend ref=arch
roadmap.create workflow_id=$backend
relation.create source_node_id=$arch target_node_id=<existing-node>
```

Always dry-run first for non-trivial patches.

## Auditability

Every material mutation should leave one or more of:
- immutable knowledge version,
- activity log,
- change set,
- snapshot.

Use `query_change_history` after complex work to confirm the audit trail.

## Health and maintenance

Use `get_project_health` to detect:
- missing operational profile fields,
- empty workflows,
- unscoped nodes,
- stale knowledge,
- blocked roadmap items,
- core nodes without relations.

Use health findings as maintenance signals, not as permission to delete or rewrite historical knowledge automatically.

## Response style

When completing PR Brain operations, report:
1. Project used.
2. What changed.
3. Verification result.
4. Any unresolved conflict, missing location, blocked item or risk.


## GitHub staged-change workflow

When the user wants agents to prepare changes in GitHub first and apply them later from the PR Brain panel, use the GitOps changeset flow.

Repository:
- `PEDIHS/PR-Brain`

Changeset directory:
- `project-sync/<project-slug>/changes/`

Rules:
1. Inspect the project with `open_project` and resolve IDs/entities before authoring the change.
2. Create a **new JSON file** for each coherent change. Never rewrite a previously applied changeset.
3. Follow `project-sync/README.md`.
4. Keep each changeset at or below 100 operations, and keep the total pending batch at or below 100 operations.
5. Use local `ref` names plus `$ref` references for entities created in the same changeset.
6. Never commit secret values.
7. Commit the changeset to the repository. Do not apply it directly to PR Brain unless the user explicitly asks for immediate application.
8. The user can then use the **بروزرسانی** control in PR Brain to preview and atomically apply all pending GitHub changes.
9. PR Brain takes a snapshot before application and records the Git blob SHA in its synchronization ledger, so the same version cannot be applied twice.

Use the GitHub connector/app when it is available to create the changeset commit.
