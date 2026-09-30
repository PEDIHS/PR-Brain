import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.PRBRAIN_MCP_URL || "http://127.0.0.1:3001/mcp";
const token = process.env.PRBRAIN_MCP_TOKEN;
if (!token) throw new Error("PRBRAIN_MCP_TOKEN is required");

const client = new Client({ name: "pr-brain-smoke-test", version: "0.1.0" });
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

await client.connect(transport);
const tools = await client.listTools();
const projects = await client.callTool({ name: "list_projects", arguments: {} });

console.log(JSON.stringify({
  server: client.getServerVersion(),
  toolCount: tools.tools.length,
  tools: tools.tools.map((tool) => tool.name),
  listProjectsResult: projects.content,
}, null, 2));

await client.close();
