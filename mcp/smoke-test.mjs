import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.PRBRAIN_MCP_URL || "http://127.0.0.1:3001/mcp";
const token = process.env.PRBRAIN_MCP_TOKEN;
if (!token) throw new Error("PRBRAIN_MCP_TOKEN is required");

const client = new Client({ name: "pr-brain-smoke-test", version: "0.4.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-PR-Brain-Agent": "PR Brain Smoke Test",
    },
  },
});

function payload(call) {
  return JSON.parse(call.content?.[0]?.text || "{}");
}

await client.connect(transport);
const tools = await client.listTools();
const [projects, opened, capabilities, health, dryRun] = await Promise.all([
  client.callTool({ name: "list_projects", arguments: {} }),
  client.callTool({
    name: "open_project",
    arguments: { project: "pr-brain", knowledge_limit: 10, change_limit: 10 },
  }),
  client.callTool({ name: "agent_capabilities", arguments: {} }),
  client.callTool({ name: "get_project_health", arguments: { project: "pr-brain", stale_days: 90 } }),
  client.callTool({
    name: "apply_project_patch",
    arguments: {
      project: "pr-brain",
      change_note: "Smoke-test dry run",
      dry_run: true,
      create_snapshot_before: false,
      operations: [
        { op: "project.update", data: { status: "active" } },
      ],
    },
  }),
]);

const projectPayload = payload(projects);
const openPayload = payload(opened);
const capPayload = payload(capabilities);
const healthPayload = payload(health);
const dryPayload = payload(dryRun);

console.log(JSON.stringify({
  server: client.getServerVersion(),
  toolCount: tools.tools.length,
  tools: tools.tools.map((tool) => tool.name),
  apiVersion: capPayload.api_version,
  projectCount: projectPayload.projects?.length,
  openProject: {
    name: openPayload.project?.name,
    domain: openPayload.operational_profile?.primary_domain,
    resourceCount: openPayload.resources?.length,
    workflowCount: openPayload.workflows?.length,
    knowledgeMapCount: openPayload.knowledge_map?.length,
  },
  health: {
    score: healthPayload.health_score,
    issueCount: healthPayload.issues?.length,
  },
  patchDryRun: {
    dryRun: dryPayload.dry_run,
    operationCount: dryPayload.operation_count,
  },
}, null, 2));

await client.close();
