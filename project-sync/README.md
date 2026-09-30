# PR Brain GitOps Change Sets

This directory is the GitHub staging layer for project changes made by agents.

## Flow

1. An agent inspects the project in PR Brain.
2. Instead of mutating production immediately, it can create a new JSON changeset under:
   `project-sync/<project-slug>/changes/`
3. The PR Brain panel detects files whose Git blob SHA has not been applied yet.
4. The user opens **بروزرسانی** in the panel, reviews pending changes, and applies them.
5. PR Brain creates a full project snapshot and applies every pending operation in one PostgreSQL transaction.
6. Applied GitHub blob SHAs are written to `github_sync_applied`, so refreshes are idempotent.

## File naming

Use sortable, unique names:

```
YYYYMMDD-HHMM-<short-purpose>.json
```

Example:

```
20260930-2215-add-backend-workflow.json
```

## Schema

```json
{
  "version": 1,
  "id": "20260930-2215-add-backend-workflow",
  "project": "taktook",
  "title": "Add backend workflow and initial architecture",
  "agent": "ChatGPT Backend Agent",
  "created_at": "2026-09-30T22:15:00+02:00",
  "notes": "Create the backend workflow and seed its first architecture nodes.",
  "operations": [
    {
      "op": "workflow.create",
      "ref": "backend",
      "data": {
        "name": "Backend",
        "slug": "backend",
        "description": "Backend services, APIs and persistence."
      }
    },
    {
      "op": "knowledge.create",
      "ref": "api_arch",
      "data": {
        "workflow_id": "$backend",
        "node_type": "architecture",
        "title": "API Architecture",
        "slug": "api-architecture",
        "summary": "Backend API architecture.",
        "content": "..."
      }
    }
  ]
}
```

## Supported operations

- `project.update`
- `workflow.create`
- `workflow.update`
- `knowledge.create`
- `knowledge.update`
- `knowledge.move`
- `knowledge.archive`
- `roadmap.create`
- `roadmap.update`
- `relation.create`
- `relation.delete`
- `resource.upsert`
- `resource.delete`

Create operations may define `ref`. Later operations in the same file may refer to the created entity as `$ref`.

## Safety rules

- Never commit passwords, API keys, session cookies, bearer tokens or secret values.
- Store secret **paths/names**, not their contents.
- Use stable slugs for new workflows and knowledge nodes.
- Use `expected_version` on important `knowledge.update` operations when concurrent edits are possible.
- Prefer one coherent change per file.
- Do not edit an already-applied changeset. Create a new changeset instead.
- Maximum combined pending batch: 100 operations.
