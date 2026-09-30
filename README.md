# PR Brain

PR Brain is a self-hosted project memory and execution workspace designed to keep multiple projects, reusable workflows, architecture decisions, roadmap items and change history in one structured source of truth.

## Core model

```
Workspace
└── Project
    ├── Workflows
    │   └── Knowledge tree
    │       └── Unlimited nested nodes
    ├── Roadmap
    ├── Activity log
    ├── Version history
    └── Context API
```

Every knowledge update creates an immutable version record and a project activity event.

## Current features

- Multi-project workspace
- Reusable project workflows
- Deep hierarchical knowledge tree
- Document, decision, architecture, requirement, research, runbook and log node types
- Immutable version history
- Project activity timeline
- Roadmap/Kanban with progress and priorities
- PostgreSQL full-text project search
- Context Pack API for future MCP/agent integrations
- Password-protected self-hosted UI
- Docker deployment with isolated PostgreSQL

## Local / server deployment

1. Copy `.env.example` to `.env`.
2. Set strong values for database password, admin password and session token.
3. Run:

```bash
docker compose up -d --build
```

The application listens on port `18250` by default.

Health check:

```bash
curl http://127.0.0.1:18250/api/health
```

## Context API

After authentication:

```
GET /api/context?projectId=<uuid>&q=<optional search topic>
```

It returns a compact structured pack containing project metadata, workflows, relevant knowledge, active roadmap items and recent changes. This endpoint is the base for the MCP integration layer.
