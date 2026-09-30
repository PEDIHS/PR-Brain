import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.PRBRAIN_MCP_URL || "http://127.0.0.1:3001/mcp";
const token = process.env.PRBRAIN_MCP_TOKEN;
if (!token) throw new Error("PRBRAIN_MCP_TOKEN is required");

const client = new Client({ name: "pr-brain-smoke-test", version: "0.3.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

await client.connect(transport);
const tools = await client.listTools();
const projects = await client.callTool({ name: "list_projects", arguments: {} });
const opened = await client.callTool({
  name: "open_project",
  arguments: { project: "pr-brain", knowledge_limit: 10, change_limit: 10 },
});

const projectPayload = JSON.parse(projects.content?.[0]?.text || "{}");
const openPayload = JSON.parse(opened.content?.[0]?.text || "{}");

console.log(JSON.stringify({
  server: client.getServerVersion(),
  toolCount: tools.tools.length,
  tools: tools.tools.map((tool) => tool.name),
  projects: projectPayload.projects?.map((p) => ({
    name: p.name,
    slug: p.slug,
    workflows: p.workflow_count,
    knowledge: p.knowledge_count,
    openRoadmap: p.open_roadmap,
  })),
  openProject: {
    name: openPayload.project?.name,
    domain: openPayload.operational_profile?.primary_domain,
    repository: openPayload.operational_profile?.repository_url,
    deployPath: openPayload.operational_profile?.deploy_path,
    resourceCount: openPayload.resources?.length,
    workflowCount: openPayload.workflows?.length,
    knowledgeMapCount: openPayload.knowledge_map?.length,
  },
}, null, 2));

await client.close();
