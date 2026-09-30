import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { query } from "@/lib/db";
import { json } from "@/lib/utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REPOSITORY = process.env.PRBRAIN_SYNC_REPOSITORY || "PEDIHS/PR-Brain";
const GIT_REF = process.env.PRBRAIN_SYNC_REF || "main";
const ALLOWED_OPS = new Set([
  "project.update","workflow.create","workflow.update",
  "knowledge.create","knowledge.update","knowledge.move","knowledge.archive",
  "roadmap.create","roadmap.update",
  "relation.create","relation.delete",
  "resource.upsert","resource.delete",
]);

type ChangeOperation = { op:string; ref?:string; data:Record<string,unknown> };
type ChangeSet = {
  version:number;
  id:string;
  project:string;
  title:string;
  agent?:string;
  created_at?:string;
  notes?:string;
  operations:ChangeOperation[];
};

type RemoteChange = {
  path:string;
  sha:string;
  html_url:string;
  change:ChangeSet;
};

function githubHeaders() {
  const headers:Record<string,string> = {
    Accept:"application/vnd.github+json",
    "User-Agent":"PR-Brain-GitOps-Sync",
    "X-GitHub-Api-Version":"2022-11-28",
  };
  if(process.env.PRBRAIN_GITHUB_TOKEN) {
    headers.Authorization=`Bearer ${process.env.PRBRAIN_GITHUB_TOKEN}`;
  }
  return headers;
}

function encodePath(path:string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function validateChangeSet(value:unknown, projectSlug:string, path:string):ChangeSet {
  if(!value || typeof value!=="object") throw new Error(`${path}: invalid JSON object`);
  const c=value as Partial<ChangeSet>;
  if(c.version!==1) throw new Error(`${path}: version must be 1`);
  if(!c.id || typeof c.id!=="string") throw new Error(`${path}: id is required`);
  if(c.project!==projectSlug) throw new Error(`${path}: project must be "${projectSlug}"`);
  if(!c.title || typeof c.title!=="string") throw new Error(`${path}: title is required`);
  if(!Array.isArray(c.operations) || !c.operations.length) throw new Error(`${path}: operations are required`);
  if(c.operations.length>100) throw new Error(`${path}: maximum 100 operations per changeset`);
  for(const [index,op] of c.operations.entries()) {
    if(!op || typeof op!=="object" || !ALLOWED_OPS.has(String(op.op))) {
      throw new Error(`${path}: unsupported operation at index ${index}`);
    }
    if(!op.data || typeof op.data!=="object" || Array.isArray(op.data)) {
      throw new Error(`${path}: operation ${index} requires data object`);
    }
  }
  return c as ChangeSet;
}

async function fetchRemoteChanges(projectSlug:string):Promise<RemoteChange[]> {
  const dir=`project-sync/${projectSlug}/changes`;
  const url=`https://api.github.com/repos/${REPOSITORY}/contents/${encodePath(dir)}?ref=${encodeURIComponent(GIT_REF)}`;
  const res=await fetch(url,{headers:githubHeaders(),cache:"no-store"});
  if(res.status===404) return [];
  if(!res.ok) throw new Error(`GitHub directory request failed: ${res.status}`);
  const items=await res.json() as Array<{type:string;name:string;path:string;sha:string;url:string;html_url:string}>;
  const files=items.filter(i=>i.type==="file" && i.name.endsWith(".json")).sort((a,b)=>a.name.localeCompare(b.name));

  const changes=await Promise.all(files.map(async item=>{
    const fileRes=await fetch(item.url,{headers:githubHeaders(),cache:"no-store"});
    if(!fileRes.ok) throw new Error(`GitHub file request failed for ${item.path}: ${fileRes.status}`);
    const file=await fileRes.json() as {content:string;encoding:string};
    if(file.encoding!=="base64") throw new Error(`${item.path}: unsupported GitHub encoding`);
    const decoded=Buffer.from(file.content.replace(/\n/g,""),"base64").toString("utf8");
    let parsed:unknown;
    try { parsed=JSON.parse(decoded); } catch { throw new Error(`${item.path}: invalid JSON`); }
    return {path:item.path,sha:item.sha,html_url:item.html_url,change:validateChangeSet(parsed,projectSlug,item.path)};
  }));
  return changes;
}

async function loadSync(projectId:string) {
  const p=(await query("SELECT id,name,slug FROM projects WHERE id=$1",[projectId])).rows[0];
  if(!p) throw new Error("Project not found");

  const remote=await fetchRemoteChanges(p.slug);
  const applied=(await query(
    `SELECT file_path,blob_sha,change_id,title,agent_name,operation_count,applied_at
     FROM github_sync_applied
     WHERE project_id=$1 AND repository=$2 AND git_ref=$3
     ORDER BY applied_at DESC`,
    [p.id,REPOSITORY,GIT_REF],
  )).rows as Array<{
    file_path:string;blob_sha:string;change_id:string;title:string;agent_name:string;
    operation_count:number;applied_at:string;
  }>;
  const appliedKeys=new Set(applied.map(r=>`${r.file_path}:${r.blob_sha}`));
  const pending=remote.filter(r=>!appliedKeys.has(`${r.path}:${r.sha}`));

  return {
    project:p,
    repository:REPOSITORY,
    git_ref:GIT_REF,
    remote,
    pending,
    applied,
  };
}

function sanitizeRef(value:string) {
  return value.replace(/[^A-Za-z0-9_-]/g,"_").slice(0,50);
}

function namespaceOperations(changes:RemoteChange[]) {
  const output:ChangeOperation[]=[];
  changes.forEach((entry,changeIndex)=>{
    const prefix=`c${changeIndex+1}_${sanitizeRef(entry.change.id)}`;
    const refs=new Map<string,string>();
    for(const op of entry.change.operations) {
      if(op.ref) refs.set(op.ref,`${prefix}_${sanitizeRef(op.ref)}`);
    }

    const replace=(v:unknown):unknown=>{
      if(typeof v==="string" && v.startsWith("$")) {
        const original=v.slice(1);
        return refs.has(original) ? `$${refs.get(original)}` : v;
      }
      if(Array.isArray(v)) return v.map(replace);
      if(v && typeof v==="object") return Object.fromEntries(Object.entries(v as Record<string,unknown>).map(([k,x])=>[k,replace(x)]));
      return v;
    };

    for(const op of entry.change.operations) {
      output.push({
        op:op.op,
        ...(op.ref?{ref:refs.get(op.ref)}:{}),
        data:replace(op.data) as Record<string,unknown>,
      });
    }
  });
  return output;
}

function summarize(changes:RemoteChange[]) {
  const byType:Record<string,number>={};
  let operations=0;
  for(const entry of changes) {
    for(const op of entry.change.operations) {
      byType[op.op]=(byType[op.op]||0)+1;
      operations++;
    }
  }
  return {changesets:changes.length,operations,by_type:byType};
}

async function callPatch(projectSlug:string,changes:RemoteChange[]) {
  const token=process.env.PRBRAIN_MCP_TOKEN;
  if(!token) throw new Error("PRBRAIN_MCP_TOKEN is not configured");

  const totalOps=changes.reduce((sum,c)=>sum+c.change.operations.length,0);
  if(totalOps>100) throw new Error(`There are ${totalOps} pending operations; maximum atomic batch is 100. Split the GitHub changes into a smaller update batch.`);

  const host=process.env.PRBRAIN_PUBLIC_HOST || "brain.pedramhs.ir";
  const mcpUrl=process.env.PRBRAIN_MCP_URL || `https://${host}/mcp`;
  const client=new Client({name:"pr-brain-panel-github-sync",version:"1.0.0"});
  const transport=new StreamableHTTPClientTransport(new URL(mcpUrl),{
    requestInit:{headers:{
      Authorization:`Bearer ${token}`,
      "X-PR-Brain-Agent":"PR Brain GitHub Sync",
    }},
  });

  try {
    await client.connect(transport);
    const sourceRecords=changes.map(entry=>({
      repository:REPOSITORY,
      git_ref:GIT_REF,
      file_path:entry.path,
      blob_sha:entry.sha,
      change_id:entry.change.id,
      title:entry.change.title,
      agent_name:entry.change.agent || "github-agent",
      operation_count:entry.change.operations.length,
    }));

    const response=await client.callTool({
      name:"apply_project_patch",
      arguments:{
        project:projectSlug,
        change_note:`GitHub update: ${changes.map(c=>c.change.title).join(" · ").slice(0,3500)}`,
        dry_run:false,
        create_snapshot_before:true,
        source_records:sourceRecords,
        operations:namespaceOperations(changes),
      },
    });
    const text=response.content?.find((x)=>x.type==="text")?.text || "";
    let parsed:Record<string,unknown>|null=null;
    try {
      parsed=text ? JSON.parse(text) as Record<string,unknown> : {};
    } catch {
      const message=text.trim() || "PR Brain MCP returned a non-JSON error";
      throw new Error(message);
    }
    if(response.isError) {
      throw new Error(String(parsed.error || parsed.message || text || "PR Brain MCP operation failed"));
    }
    if(parsed.error) throw new Error(String(parsed.error));
    return parsed;
  } finally {
    await client.close().catch(()=>{});
  }
}

export async function GET(request:Request) {
  try {
    const url=new URL(request.url);
    const projectId=url.searchParams.get("projectId");
    if(!projectId) return json({error:"projectId is required"},{status:400});
    const state=await loadSync(projectId);
    return json({
      project:state.project,
      repository:state.repository,
      git_ref:state.git_ref,
      sync_path:`project-sync/${state.project.slug}/changes/`,
      summary:summarize(state.pending),
      pending:state.pending.map(x=>({
        path:x.path,sha:x.sha,html_url:x.html_url,
        id:x.change.id,title:x.change.title,agent:x.change.agent||"github-agent",
        created_at:x.change.created_at||null,notes:x.change.notes||"",
        operation_count:x.change.operations.length,
        operations:x.change.operations.map(o=>({op:o.op,ref:o.ref||null,data_keys:Object.keys(o.data)})),
      })),
      recent_applied:state.applied.slice(0,20),
    });
  } catch(error) {
    return json({error:error instanceof Error?error.message:"GitHub sync failed"},{status:500});
  }
}

export async function POST(request:Request) {
  try {
    const body=await request.json().catch(()=>({}));
    if(!body.projectId) return json({error:"projectId is required"},{status:400});
    const state=await loadSync(body.projectId);
    if(!state.pending.length) return json({ok:true,applied:0,message:"No pending GitHub changes"});
    const patch=await callPatch(state.project.slug,state.pending);
    return json({
      ok:true,
      applied:state.pending.length,
      summary:summarize(state.pending),
      snapshot:patch.snapshot||null,
      refs:patch.refs||{},
      results:patch.results||[],
    });
  } catch(error) {
    return json({error:error instanceof Error?error.message:"GitHub update failed"},{status:500});
  }
}
