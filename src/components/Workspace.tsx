"use client";

import {
  Activity, Archive, Blocks, BookOpen, BrainCircuit, CalendarDays, CheckCircle2,
  ChevronDown, ChevronLeft, ChevronRight, CircleDot, Clock3, FileClock, FileText,
  FolderTree, GitBranch, History, LayoutDashboard, ListChecks, Loader2, LogOut,
  Milestone, MoreHorizontal, Plus, Search, Settings2, Sparkles, Target, Workflow,
  X, Globe2, Server, FolderCog, HeartPulse, Pencil, Save
} from "lucide-react";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import { motion, AnimatePresence } from "motion/react";
import { Group, Panel, Separator } from "react-resizable-panels";
import KnowledgeGraph, { type GraphRelation } from "./KnowledgeGraph";

type Project = {
  id:string; name:string; slug:string; description:string; status:string; accent:string;
  node_count:number; updated_at:string;
};
type WorkflowRow = { id:string; project_id:string; name:string; slug:string; description:string; position:number };
type NodeRow = {
  id:string; project_id:string; workflow_id:string|null; parent_id:string|null; node_type:string;
  title:string; slug:string; summary:string; content:string; status:string; metadata:Record<string,unknown>;
  current_version:number; position:number; created_at:string; updated_at:string;
};
type RoadmapRow = {
  id:string; project_id:string; workflow_id:string|null; parent_id:string|null; title:string;
  description:string; status:string; priority:string; progress:number; target_date:string|null;
  position:number; created_at:string; updated_at:string;
};
type ActivityRow = {
  id:number; project_id:string; entity_type:string; entity_id:string|null; action:string; title:string;
  details:Record<string,unknown>; actor:string; created_at:string;
};
type ProjectProfile = {
  project_id:string; primary_domain:string; repository_url:string; default_branch:string;
  server_host:string; server_alias:string; deploy_path:string; web_root:string; env_path:string;
  compose_path:string; runtime:string; healthcheck_url:string; readme_md:string; agent_rules_md:string;
  metadata:Record<string,unknown>; updated_at:string;
};
type ProjectResource = {
  id:string; project_id:string; kind:string; name:string; value:string; environment:string;
  is_primary:boolean; metadata:Record<string,unknown>; created_at:string; updated_at:string;
};
type Bootstrap = {
  projects:Project[]; project:Project|null; workflows:WorkflowRow[]; nodes:NodeRow[];
  roadmap:RoadmapRow[]; activity:ActivityRow[];
  metrics?:{knowledge:number;workflows:number;open_roadmap:number;versions:number;changes_7d:number};
  profile?:ProjectProfile|null; resources?:ProjectResource[]; relations?:GraphRelation[];
};
type Detail = {
  node:NodeRow;
  versions:Array<{id:number;version:number;change_note:string;actor:string;created_at:string}>;
  relations:Array<GraphRelation & {source_title?:string;target_title?:string}>;
};

const sections = [
  {id:"overview",label:"نمای کلی",icon:LayoutDashboard},
  {id:"readme",label:"README پروژه",icon:BookOpen},
  {id:"knowledge",label:"درخت دانش",icon:FolderTree},
  {id:"roadmap",label:"رودمپ",icon:Milestone},
  {id:"activity",label:"تغییرات",icon:Activity},
] as const;

const typeLabels:Record<string,string> = {
  folder:"پوشه", document:"سند", decision:"تصمیم", architecture:"معماری",
  requirement:"نیازمندی", research:"تحقیق", runbook:"راهنما", log:"لاگ",
};

const statusMap:Record<string,string> = {
  planned:"برنامه‌ریزی", in_progress:"در حال انجام", blocked:"مسدود", done:"انجام‌شده",
};

const workflowPalette = [
  {color:"#6C5CE7",soft:"#F0EDFF"},
  {color:"#0984E3",soft:"#EAF5FF"},
  {color:"#00A884",soft:"#E7F8F3"},
  {color:"#E17055",soft:"#FFF0EC"},
  {color:"#D99B26",soft:"#FFF7E4"},
  {color:"#B05AC9",soft:"#F8ECFC"},
  {color:"#D64C7F",soft:"#FDECF3"},
  {color:"#4D7C8A",soft:"#EAF3F5"},
] as const;

function fmtDate(input:string) {
  try { return new Intl.DateTimeFormat("fa-IR",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(input)); }
  catch { return input; }
}

function TypeIcon({type,size=15}:{type:string;size?:number}) {
  if (type==="folder") return <FolderTree size={size}/>;
  if (type==="decision") return <CheckCircle2 size={size}/>;
  if (type==="architecture") return <GitBranch size={size}/>;
  if (type==="research") return <BookOpen size={size}/>;
  if (type==="log") return <FileClock size={size}/>;
  return <FileText size={size}/>;
}

type TreeItem = {
  id:string;
  name:string;
  node:NodeRow;
  children?:TreeItem[];
};

function buildTree(nodes:NodeRow[]):TreeItem[] {
  const ids=new Set(nodes.map(n=>n.id));
  const children=new Map<string,NodeRow[]>();
  for(const n of nodes) {
    const parent=n.parent_id && ids.has(n.parent_id) ? n.parent_id : "__root__";
    const list=children.get(parent)||[];
    list.push(n);
    children.set(parent,list);
  }
  for(const list of children.values()) list.sort((a,b)=>a.position-b.position||a.title.localeCompare(b.title));
  const walk=(parent:string):TreeItem[] => (children.get(parent)||[]).map(n=>({
    id:n.id,
    name:n.title,
    node:n,
    children:walk(n.id),
  }));
  return walk("__root__");
}

function ArborNode({node,style,dragHandle}:NodeRendererProps<TreeItem>) {
  const item=node.data.node;
  return (
    <div style={style} ref={dragHandle} className="arbor-row-wrap">
      <motion.div
        className={"arbor-node "+(node.isSelected?"selected":"")}
        style={{paddingInlineStart:10+node.level*22,"--level":node.level} as React.CSSProperties}
        initial={{opacity:0,y:3}}
        animate={{opacity:1,y:0}}
        transition={{duration:.16}}
        whileHover={{x:-2}}
        onClick={(e)=>node.handleClick(e)}
      >
        <span className="tree-connector" aria-hidden="true"/>
        <button className="arbor-toggle" onClick={(e)=>{e.stopPropagation();node.toggle()}}>
          {node.isLeaf ? <CircleDot size={9}/> : node.isOpen ? <ChevronDown size={14}/> : <ChevronLeft size={14}/>}
        </button>
        <span className={"tree-type type-"+item.node_type}><TypeIcon type={item.node_type}/></span>
        <span className="arbor-copy">
          <strong>{item.title}</strong>
          <small>{item.summary || typeLabels[item.node_type] || item.node_type}</small>
        </span>
        <span className="arbor-meta">{typeLabels[item.node_type]||item.node_type}</span>
        <span className="tree-version">v{item.current_version}</span>
      </motion.div>
    </div>
  );
}

function KnowledgeTree({
  nodes,selection,onOpen,onMove
}:{
  nodes:NodeRow[];
  selection?:string;
  onOpen:(n:NodeRow)=>void;
  onMove:(ids:string[],parentId:string|null,index:number)=>Promise<void>;
}) {
  const host=useRef<HTMLDivElement>(null);
  const [width,setWidth]=useState(800);
  const treeData=useMemo(()=>buildTree(nodes),[nodes]);

  useEffect(()=>{
    if(!host.current) return;
    const ro=new ResizeObserver(([entry])=>setWidth(Math.max(320,Math.floor(entry.contentRect.width))));
    ro.observe(host.current);
    return ()=>ro.disconnect();
  },[]);

  if(!nodes.length) return <div className="tree-empty-state"><FolderTree size={28}/><strong>این Workflow هنوز خالی است</strong><span>یک سند، تصمیم یا پوشه جدید ایجاد کن.</span></div>;

  return (
    <div className="knowledge-tree-shell" ref={host}>
      <Tree<TreeItem>
        data={treeData}
        width={width}
        height={Math.min(680,Math.max(360,nodes.length*48+28))}
        indent={24}
        rowHeight={48}
        overscanCount={8}
        openByDefault
        selection={selection}
        onActivate={(n)=>onOpen(n.data.node)}
        onMove={async({dragIds,parentId,index})=>onMove(dragIds,parentId,index)}
      >
        {ArborNode}
      </Tree>
    </div>
  );
}

export default function Workspace() {
  const [data,setData] = useState<Bootstrap|null>(null);
  const [loading,setLoading] = useState(true);
  const [section,setSection] = useState<typeof sections[number]["id"]>("overview");
  const [selectedWorkflowId,setSelectedWorkflowId] = useState<string>("");
  const [knowledgeMode,setKnowledgeMode] = useState<"tree"|"graph">("tree");
  const [projectId,setProjectId] = useState<string>("");
  const [detail,setDetail] = useState<Detail|null>(null);
  const [detailLoading,setDetailLoading] = useState(false);
  const [queryText,setQueryText] = useState("");
  const [searchResults,setSearchResults] = useState<NodeRow[]>([]);
  const [searchOpen,setSearchOpen] = useState(false);
  const [createKind,setCreateKind] = useState<"project"|"knowledge"|"roadmap"|"workflow"|null>(null);
  const [saving,setSaving] = useState(false);
  const [editing,setEditing] = useState(false);
  const [profileEditing,setProfileEditing] = useState(false);
  const [mobileNav,setMobileNav] = useState(false);

  const load = useCallback(async (nextProject?:string) => {
    setLoading(true);
    const id = nextProject || projectId;
    const res = await fetch("/api/bootstrap"+(id?`?projectId=${encodeURIComponent(id)}`:""),{cache:"no-store"});
    const json = await res.json();
    setData(json);
    if (json.project?.id) setProjectId(json.project.id);
    setLoading(false);
  },[projectId]);

  useEffect(()=>{ load(""); },[]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(()=>{
    if(!data?.workflows.length) { setSelectedWorkflowId(""); return; }
    if(!selectedWorkflowId || !data.workflows.some(w=>w.id===selectedWorkflowId)) {
      setSelectedWorkflowId(data.workflows[0].id);
    }
  },[data,selectedWorkflowId]);

  useEffect(()=>{
    const handler = (e:KeyboardEvent) => {
      if ((e.metaKey||e.ctrlKey) && e.key.toLowerCase()==="k") { e.preventDefault(); setSearchOpen(true); }
      if (e.key==="Escape") { setSearchOpen(false); setCreateKind(null); }
    };
    window.addEventListener("keydown",handler);
    return ()=>window.removeEventListener("keydown",handler);
  },[]);

  useEffect(()=>{
    if (!searchOpen || queryText.trim().length<2 || !projectId) { setSearchResults([]); return; }
    const t=setTimeout(async()=>{
      const r=await fetch(`/api/search?projectId=${projectId}&q=${encodeURIComponent(queryText)}`);
      const j=await r.json();
      setSearchResults(j.results||[]);
    },220);
    return ()=>clearTimeout(t);
  },[queryText,searchOpen,projectId]);

  const openNode = async (node:NodeRow) => {
    setDetailLoading(true); setDetail(null); setEditing(false);
    const res=await fetch("/api/knowledge/"+node.id,{cache:"no-store"});
    setDetail(await res.json());
    setDetailLoading(false);
  };

  const selectedWorkflow = useMemo(
    ()=>data?.workflows.find(w=>w.id===selectedWorkflowId)||null,
    [data,selectedWorkflowId]
  );
  const selectedWorkflowNodes = useMemo(
    ()=>data?.nodes.filter(n=>n.workflow_id===selectedWorkflowId)||[],
    [data,selectedWorkflowId]
  );

  const roadmapByStatus = useMemo(()=>{
    const base:{[k:string]:RoadmapRow[]}={planned:[],in_progress:[],blocked:[],done:[]};
    data?.roadmap.forEach(i=>(base[i.status]??base.planned).push(i));
    return base;
  },[data]);

  async function submitCreate(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!data?.project) return;
    setSaving(true);
    const fd=new FormData(e.currentTarget);
    let endpoint="/api/knowledge";
    let payload:Record<string,unknown>={projectId:data.project.id};

    if(createKind==="project") {
      endpoint="/api/projects";
      payload={name:fd.get("name"),description:fd.get("description")};
    } else if(createKind==="workflow") {
      endpoint="/api/workflows";
      payload={projectId:data.project.id,name:fd.get("name"),description:fd.get("description")};
    } else if(createKind==="roadmap") {
      endpoint="/api/roadmap";
      payload={projectId:data.project.id,title:fd.get("title"),description:fd.get("description"),
        workflowId:fd.get("workflowId")||null,priority:fd.get("priority")||"medium",status:"planned"};
    } else {
      payload={projectId:data.project.id,title:fd.get("title"),summary:fd.get("summary"),
        content:fd.get("content"),workflowId:fd.get("workflowId")||null,parentId:fd.get("parentId")||null,
        nodeType:fd.get("nodeType")||"document",changeNote:"Created from workspace"};
    }

    const res=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)});
    const out=await res.json().catch(()=>({}));
    if(res.ok) {
      setCreateKind(null);
      if(createKind==="project" && out.project?.id) { setProjectId(out.project.id); await load(out.project.id); }
      else await load();
    }
    setSaving(false);
  }

  async function saveProjectProfile(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!data?.project) return;
    setSaving(true);
    const fd=new FormData(e.currentTarget);
    const payload={
      projectId:data.project.id,
      primary_domain:fd.get("primary_domain"),
      repository_url:fd.get("repository_url"),
      default_branch:fd.get("default_branch"),
      server_host:fd.get("server_host"),
      server_alias:fd.get("server_alias"),
      deploy_path:fd.get("deploy_path"),
      web_root:fd.get("web_root"),
      env_path:fd.get("env_path"),
      compose_path:fd.get("compose_path"),
      runtime:fd.get("runtime"),
      healthcheck_url:fd.get("healthcheck_url"),
      readme_md:fd.get("readme_md"),
      agent_rules_md:fd.get("agent_rules_md"),
      changeNote:"Operational profile updated from UI",
    };
    const res=await fetch("/api/project-profile",{
      method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(payload)
    });
    if(res.ok){ await load(); setProfileEditing(false); }
    setSaving(false);
  }

  async function saveNode(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); if(!detail) return;
    setSaving(true);
    const fd=new FormData(e.currentTarget);
    const res=await fetch("/api/knowledge/"+detail.node.id,{
      method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        title:fd.get("title"),summary:fd.get("summary"),content:fd.get("content"),
        status:fd.get("status"),changeNote:fd.get("changeNote")||"Manual update",
      })
    });
    if(res.ok) {
      const node=(await res.json()).node;
      await load();
      await openNode(node);
      setEditing(false);
    }
    setSaving(false);
  }

  async function moveKnowledge(dragIds:string[],parentId:string|null,index:number) {
    if(!selectedWorkflowId || !dragIds.length) return;
    setSaving(true);
    try {
      await Promise.all(dragIds.map((id,offset)=>fetch("/api/knowledge/"+id,{
        method:"PATCH",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          workflowId:selectedWorkflowId,
          parentId,
          position:(index+offset+1)*10,
          changeNote:"Reorganized from visual knowledge tree",
        }),
      }).then(async r=>{ if(!r.ok) throw new Error((await r.json()).error||"Move failed"); })));
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function moveRoadmap(item:RoadmapRow,status:string) {
    await fetch("/api/roadmap",{method:"PATCH",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({id:item.id,status,progress:status==="done"?100:item.progress})});
    await load();
  }

  async function logout() {
    await fetch("/api/auth/logout",{method:"POST"});
    location.href="/login";
  }

  if(loading && !data) return <main className="boot"><div className="brand-loader"><BrainCircuit/><span>PR Brain</span></div><Loader2 className="spin"/></main>;
  if(!data?.project) return <main className="boot">No project available.</main>;

  return (
    <main className="app-shell">
      <aside className={"sidebar "+(mobileNav?"mobile-open":"")}>
        <div className="brand">
          <div className="brand-icon"><BrainCircuit size={20}/></div>
          <div><strong>PR Brain</strong><span>Project memory</span></div>
          <button className="icon-button sidebar-close" onClick={()=>setMobileNav(false)}><X size={18}/></button>
        </div>

        <div className="project-switcher">
          <label>پروژه فعال</label>
          <button className="project-current">
            <span className="project-dot" style={{background:data.project.accent}}/>
            <span><b>{data.project.name}</b><small>{data.project.status}</small></span>
            <ChevronDown size={15}/>
          </button>
          <div className="project-menu-inline">
            {data.projects.filter(p=>p.id!==data.project?.id).slice(0,4).map(p=>
              <button key={p.id} onClick={()=>{setProjectId(p.id);load(p.id);setDetail(null)}}>
                <span className="tiny-dot" style={{background:p.accent}}/>{p.name}
              </button>
            )}
            <button className="add-project" onClick={()=>setCreateKind("project")}><Plus size={14}/> پروژه جدید</button>
          </div>
        </div>

        <nav className="side-nav">
          <span className="nav-caption">WORKSPACE</span>
          {sections.map(item=>{
            const Icon=item.icon;
            return <button key={item.id} className={section===item.id?"active":""}
              onClick={()=>{setSection(item.id);setMobileNav(false)}}>
              <Icon size={16}/><span>{item.label}</span>
              {item.id==="roadmap" && <em>{data.metrics?.open_roadmap||0}</em>}
            </button>
          })}
        </nav>

        <div className="workflow-nav">
          <div className="nav-caption-row"><span className="nav-caption">WORKFLOWS</span><button onClick={()=>setCreateKind("workflow")}><Plus size={13}/></button></div>
          {data.workflows.map((w,i)=><motion.button
            key={w.id}
            className={selectedWorkflowId===w.id?"active-workflow":""}
            style={{"--wf":workflowPalette[i%workflowPalette.length].color,"--wf-soft":workflowPalette[i%workflowPalette.length].soft} as React.CSSProperties}
            whileHover={{x:-3}}
            whileTap={{scale:.98}}
            onClick={()=>{setSelectedWorkflowId(w.id);setSection("knowledge");setMobileNav(false)}}
          >
            <span className="workflow-nav-mark"/><span>{w.name}</span><small>{data.nodes.filter(n=>n.workflow_id===w.id).length}</small>
          </motion.button>)}
        </div>

        <div className="sidebar-bottom">
          <button onClick={()=>{setSection("readme");setProfileEditing(true);setMobileNav(false)}}><Settings2 size={16}/><span>تنظیمات پروژه</span></button>
          <button onClick={logout}><LogOut size={16}/><span>خروج</span></button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <button className="icon-button mobile-menu" onClick={()=>setMobileNav(true)}><MoreHorizontal size={20}/></button>
            <div><span className="breadcrumb">Workspace / {data.project.name}</span><h1>{sections.find(s=>s.id===section)?.label}</h1></div>
          </div>
          <div className="topbar-actions">
            <button className="search-trigger" onClick={()=>setSearchOpen(true)}><Search size={16}/><span>جستجو در پروژه</span><kbd>⌘ K</kbd></button>
            <button className="secondary-button" onClick={()=>setCreateKind("knowledge")}><Plus size={15}/> ثبت دانش</button>
          </div>
        </header>

        <div className="content-area">
          {section==="overview" && <div className="page overview-page">
            <div className="hero-row">
              <div>
                <span className="eyebrow">PROJECT OVERVIEW</span>
                <h2>{data.project.name}</h2>
                <p>{data.project.description}</p>
              </div>
              <div className="hero-actions">
                <button className="secondary-button" onClick={()=>setCreateKind("roadmap")}><Target size={15}/> آیتم رودمپ</button>
                <button className="primary-button" onClick={()=>setCreateKind("knowledge")}><Plus size={15}/> سند جدید</button>
              </div>
            </div>

            <section className="operational-strip">
              <div className="op-item"><span><Globe2 size={14}/> Domain</span><strong>{data.profile?.primary_domain || "ثبت نشده"}</strong></div>
              <div className="op-item"><span><GitBranch size={14}/> Repository</span><strong>{data.profile?.repository_url ? data.profile.repository_url.replace("https://github.com/","") : "ثبت نشده"}</strong></div>
              <div className="op-item"><span><Server size={14}/> Server</span><strong>{data.profile?.server_host || "ثبت نشده"}</strong></div>
              <div className="op-item"><span><FolderCog size={14}/> Deploy</span><strong>{data.profile?.deploy_path || "ثبت نشده"}</strong></div>
              <button className="op-open" onClick={()=>setSection("readme")}>مشاهده پروفایل کامل <ChevronLeft size={14}/></button>
            </section>

            <div className="metric-grid">
              <div className="metric-card"><span><Archive size={17}/>دانش ثبت‌شده</span><strong>{data.metrics?.knowledge||0}</strong><small>node در درخت پروژه</small></div>
              <div className="metric-card"><span><Workflow size={17}/>Workflowها</span><strong>{data.metrics?.workflows||0}</strong><small>مسیر کاری فعال</small></div>
              <div className="metric-card"><span><History size={17}/>نسخه‌ها</span><strong>{data.metrics?.versions||0}</strong><small>snapshot غیرقابل‌حذف</small></div>
              <div className="metric-card"><span><Activity size={17}/>تغییرات ۷ روز</span><strong>{data.metrics?.changes_7d||0}</strong><small>رویداد ثبت‌شده</small></div>
            </div>

            <div className="overview-grid">
              <section className="panel">
                <div className="panel-head"><div><span className="eyebrow">WORKFLOWS</span><h3>نقشه کاری پروژه</h3></div><button className="text-button" onClick={()=>setCreateKind("workflow")}><Plus size={14}/> افزودن</button></div>
                <div className="workflow-cards">
                  {data.workflows.map((w,i)=><motion.button
                    key={w.id}
                    className="workflow-card"
                    style={{"--wf":workflowPalette[i%workflowPalette.length].color,"--wf-soft":workflowPalette[i%workflowPalette.length].soft} as React.CSSProperties}
                    whileHover={{y:-2,scale:1.005}}
                    whileTap={{scale:.99}}
                    onClick={()=>{setSelectedWorkflowId(w.id);setSection("knowledge")}}
                  >
                    <span className="workflow-index">{String(i+1).padStart(2,"0")}</span>
                    <div><strong>{w.name}</strong><p>{w.description}</p></div>
                    <span className="workflow-count">{data.nodes.filter(n=>n.workflow_id===w.id).length}</span>
                  </motion.button>)}
                </div>
              </section>

              <section className="panel">
                <div className="panel-head"><div><span className="eyebrow">RECENT CHANGES</span><h3>آخرین تغییرات</h3></div><button className="text-button" onClick={()=>setSection("activity")}>مشاهده همه</button></div>
                <div className="activity-list compact">
                  {data.activity.slice(0,7).map(a=><div className="activity-item" key={a.id}>
                    <span className={"activity-icon action-"+a.action}>{a.action==="created"?<Plus size={14}/>:<History size={14}/>}</span>
                    <div><strong>{a.title}</strong><small>{a.actor} · {fmtDate(a.created_at)}</small></div>
                  </div>)}
                </div>
              </section>
            </div>

            <section className="panel roadmap-snapshot">
              <div className="panel-head"><div><span className="eyebrow">ROADMAP</span><h3>وضعیت اجرا</h3></div><button className="text-button" onClick={()=>setSection("roadmap")}>باز کردن رودمپ</button></div>
              <div className="roadmap-lines">
                {data.roadmap.slice(0,6).map(r=><div className="roadmap-line" key={r.id}>
                  <div><span className={"priority-dot p-"+r.priority}/><strong>{r.title}</strong><small>{statusMap[r.status]||r.status}</small></div>
                  <div className="progress-track"><span style={{width:r.progress+"%"}}/></div><b>{r.progress}%</b>
                </div>)}
              </div>
            </section>
          </div>}

          {section==="readme" && <div className="page readme-page">
            <div className="page-heading">
              <div><span className="eyebrow">PROJECT ENTRYPOINT</span><h2>README و پروفایل عملیاتی</h2><p>نقطه ورود سریع انسان و Agent به ساختار، آدرس‌ها و قوانین پروژه.</p></div>
              <button className={profileEditing?"primary-button":"secondary-button"} onClick={()=>setProfileEditing(!profileEditing)}>
                {profileEditing?<><X size={15}/> بستن ویرایش</>:<><Pencil size={15}/> ویرایش پروفایل</>}
              </button>
            </div>

            {!profileEditing ? <>
              <section className="profile-grid">
                <article className="profile-card"><span><Globe2 size={15}/>Domain</span><strong>{data.profile?.primary_domain || "ثبت نشده"}</strong><small>Primary public domain</small></article>
                <article className="profile-card"><span><GitBranch size={15}/>Repository</span><strong>{data.profile?.repository_url || "ثبت نشده"}</strong><small>Branch: {data.profile?.default_branch || "—"}</small></article>
                <article className="profile-card"><span><Server size={15}/>Server</span><strong>{data.profile?.server_host || "ثبت نشده"}</strong><small>{data.profile?.server_alias ? "Alias: "+data.profile.server_alias : "No alias"}</small></article>
                <article className="profile-card"><span><FolderCog size={15}/>Deploy path</span><strong>{data.profile?.deploy_path || "ثبت نشده"}</strong><small>{data.profile?.runtime || "Runtime ثبت نشده"}</small></article>
                <article className="profile-card"><span><FileText size={15}/>.env</span><strong>{data.profile?.env_path || "ثبت نشده"}</strong><small>Secrets are never stored in Brain</small></article>
                <article className="profile-card"><span><Blocks size={15}/>Compose</span><strong>{data.profile?.compose_path || "ثبت نشده"}</strong><small>{data.profile?.web_root || "Web root ثبت نشده"}</small></article>
                <article className="profile-card"><span><HeartPulse size={15}/>Healthcheck</span><strong>{data.profile?.healthcheck_url || "ثبت نشده"}</strong><small>Operational health endpoint</small></article>
                <article className="profile-card"><span><Workflow size={15}/>Resources</span><strong>{data.resources?.length || 0} resource</strong><small>Domain · path · endpoint · service · repository</small></article>
              </section>

              <div className="readme-layout">
                <section className="panel readme-panel">
                  <div className="panel-head"><div><span className="eyebrow">README</span><h3>Project README</h3></div><span className="readme-updated">{data.profile?.updated_at ? fmtDate(data.profile.updated_at) : ""}</span></div>
                  <div className="readme-document">{data.profile?.readme_md || "README این پروژه هنوز ثبت نشده."}</div>
                </section>

                <aside className="readme-side">
                  <section className="panel rules-panel">
                    <div className="panel-head"><div><span className="eyebrow">AGENT RULES</span><h3>قوانین Agent</h3></div></div>
                    <div className="rules-document">{data.profile?.agent_rules_md || "قانون اختصاصی ثبت نشده."}</div>
                  </section>
                  <section className="panel resources-panel">
                    <div className="panel-head"><div><span className="eyebrow">LOCATIONS</span><h3>منابع و مسیرها</h3></div></div>
                    <div className="resource-list">
                      {(data.resources||[]).map(r=><div className="resource-row" key={r.id}>
                        <span className="resource-kind">{r.kind}</span>
                        <div><strong>{r.name}</strong><code>{r.value}</code></div>
                        <small>{r.environment}</small>
                      </div>)}
                      {!data.resources?.length && <div className="empty-inline">منبعی ثبت نشده.</div>}
                    </div>
                  </section>
                </aside>
              </div>
            </> : <form className="panel profile-editor" onSubmit={saveProjectProfile}>
              <div className="editor-section-title"><span className="eyebrow">OPERATIONAL COORDINATES</span><h3>آدرس‌های دقیق پروژه</h3></div>
              <div className="profile-form-grid">
                <label>دامنه اصلی<input name="primary_domain" defaultValue={data.profile?.primary_domain||""} placeholder="example.com"/></label>
                <label>Repository<input name="repository_url" defaultValue={data.profile?.repository_url||""} placeholder="https://github.com/..."/></label>
                <label>Branch<input name="default_branch" defaultValue={data.profile?.default_branch||"main"}/></label>
                <label>Server host / IP<input name="server_host" defaultValue={data.profile?.server_host||""}/></label>
                <label>Server alias<input name="server_alias" defaultValue={data.profile?.server_alias||""} placeholder="pedram2"/></label>
                <label>Deploy path<input name="deploy_path" defaultValue={data.profile?.deploy_path||""} placeholder="/opt/project"/></label>
                <label>Web root<input name="web_root" defaultValue={data.profile?.web_root||""}/></label>
                <label>.env path<input name="env_path" defaultValue={data.profile?.env_path||""}/></label>
                <label>Compose path<input name="compose_path" defaultValue={data.profile?.compose_path||""}/></label>
                <label>Runtime<input name="runtime" defaultValue={data.profile?.runtime||""} placeholder="Docker Compose · Next.js · PostgreSQL"/></label>
                <label className="wide">Healthcheck<input name="healthcheck_url" defaultValue={data.profile?.healthcheck_url||""}/></label>
              </div>
              <label>README<textarea name="readme_md" rows={18} defaultValue={data.profile?.readme_md||""}/></label>
              <label>Agent Rules<textarea name="agent_rules_md" rows={10} defaultValue={data.profile?.agent_rules_md||""}/></label>
              <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setProfileEditing(false)}>لغو</button><button className="primary-button" disabled={saving}><Save size={14}/>{saving?"در حال ذخیره…":"ذخیره پروفایل"}</button></div>
            </form>}
          </div>}

          {section==="knowledge" && <motion.div
            className="page knowledge-page knowledge-studio-page"
            initial={{opacity:0,y:8}}
            animate={{opacity:1,y:0}}
            transition={{duration:.24,ease:"easeOut"}}
          >
            <div className="page-heading knowledge-heading">
              <div>
                <span className="eyebrow">KNOWLEDGE STUDIO</span>
                <h2>درخت، سند و Context در یک Workspace</h2>
                <p>ساختار را در Tree مدیریت کن، محتوا را همان‌جا بخوان و Version/Relationها را بدون ترک صفحه ببین.</p>
              </div>
              <div className="knowledge-heading-actions">
                <div className="view-switcher">
                  <button className={knowledgeMode==="tree"?"active":""} onClick={()=>setKnowledgeMode("tree")}><FolderTree size={14}/> Tree</button>
                  <button className={knowledgeMode==="graph"?"active":""} onClick={()=>setKnowledgeMode("graph")}><GitBranch size={14}/> Graph</button>
                </div>
                <button className="primary-button" onClick={()=>setCreateKind("knowledge")}><Plus size={15}/> ثبت دانش</button>
              </div>
            </div>

            <div className="workflow-tabs" role="tablist" aria-label="Workflow selector">
              {data.workflows.map((w,i)=>{
                const p=workflowPalette[i%workflowPalette.length];
                const count=data.nodes.filter(n=>n.workflow_id===w.id).length;
                return <motion.button
                  key={w.id}
                  role="tab"
                  aria-selected={selectedWorkflowId===w.id}
                  className={selectedWorkflowId===w.id?"active":""}
                  style={{"--wf":p.color,"--wf-soft":p.soft} as React.CSSProperties}
                  whileHover={{y:-2}}
                  whileTap={{scale:.97}}
                  onClick={()=>{setSelectedWorkflowId(w.id);setDetail(null);setEditing(false)}}
                >
                  <span className="workflow-tab-icon"><Workflow size={15}/></span>
                  <span><strong>{w.name}</strong><small>{count} node</small></span>
                </motion.button>
              })}
            </div>

            <AnimatePresence mode="wait">
              <motion.section
                key={selectedWorkflowId+"-"+knowledgeMode}
                className="knowledge-explorer knowledge-studio panel"
                initial={{opacity:0,scale:.995}}
                animate={{opacity:1,scale:1}}
                exit={{opacity:0,scale:.995}}
                transition={{duration:.18}}
                style={{
                  "--wf":workflowPalette[Math.max(0,data.workflows.findIndex(w=>w.id===selectedWorkflowId))%workflowPalette.length].color,
                  "--wf-soft":workflowPalette[Math.max(0,data.workflows.findIndex(w=>w.id===selectedWorkflowId))%workflowPalette.length].soft,
                } as React.CSSProperties}
              >
                <div className="knowledge-explorer-head">
                  <div className="workflow-orb"><Workflow size={18}/></div>
                  <div>
                    <span className="eyebrow">ACTIVE WORKFLOW</span>
                    <h3>{selectedWorkflow?.name || "Workflow"}</h3>
                    <p>{selectedWorkflow?.description || "Workflow description"}</p>
                  </div>
                  <div className="knowledge-head-stats">
                    <span><b>{selectedWorkflowNodes.length}</b> node</span>
                    <span><b>{selectedWorkflowNodes.filter(n=>n.node_type==="decision").length}</b> decision</span>
                    <span><b>{selectedWorkflowNodes.filter(n=>n.node_type==="architecture").length}</b> architecture</span>
                  </div>
                </div>

                {knowledgeMode==="graph" ? <div className="graph-studio">
                  <div className="tree-toolbar">
                    <span><GitBranch size={12}/> Hierarchy و Relationهای ثبت‌شده در Brain</span>
                    <span>{(data.relations||[]).filter(r=>selectedWorkflowNodes.some(n=>n.id===r.source_node_id||n.id===r.target_node_id)).length} relation</span>
                  </div>
                  <KnowledgeGraph
                    nodes={selectedWorkflowNodes}
                    relations={data.relations||[]}
                    selectedId={detail?.node.id}
                    onOpen={(node)=>openNode(node as NodeRow)}
                  />
                </div> : <div className="studio-panels">
                  <Group orientation="horizontal" className="knowledge-panel-group">
                    <Panel id="tree-panel" defaultSize="30%" minSize="22%" maxSize="44%">
                      <section className="studio-pane tree-pane">
                        <div className="studio-pane-head">
                          <div><span className="eyebrow">EXPLORER</span><strong>ساختار {selectedWorkflow?.name}</strong></div>
                          <span>{selectedWorkflowNodes.length}</span>
                        </div>
                        <div className="tree-toolbar">
                          <span><CircleDot size={12}/> Drag & Drop برای جابه‌جایی شاخه</span>
                          {saving && <span className="tree-saving"><Loader2 size={12} className="spin"/> ذخیره…</span>}
                        </div>
                        <KnowledgeTree
                          nodes={selectedWorkflowNodes}
                          selection={detail?.node.id}
                          onOpen={openNode}
                          onMove={moveKnowledge}
                        />
                      </section>
                    </Panel>

                    <Separator className="studio-separator"><span/></Separator>

                    <Panel id="document-panel" defaultSize="45%" minSize="31%">
                      <section className="studio-pane document-pane">
                        {detailLoading ? <div className="studio-empty"><Loader2 className="spin"/><strong>در حال بازکردن سند…</strong></div>
                        : detail ? <>
                          <div className="studio-document-head">
                            <div className={"studio-document-icon type-"+detail.node.node_type}><TypeIcon type={detail.node.node_type} size={18}/></div>
                            <div>
                              <span className="eyebrow">{typeLabels[detail.node.node_type]||detail.node.node_type}</span>
                              <h3>{detail.node.title}</h3>
                              <p>{detail.node.summary||"بدون خلاصه"}</p>
                            </div>
                            <div className="studio-document-actions">
                              <span>v{detail.node.current_version}</span>
                              <button className="secondary-button" onClick={()=>setEditing(!editing)}>{editing?"بستن ویرایش":"ویرایش"}</button>
                            </div>
                          </div>

                          {!editing ? <div className="studio-document-body">
                            <div className="document-content studio-document-content">{detail.node.content||"هنوز محتوایی ثبت نشده."}</div>
                          </div> : <form className="studio-edit-form edit-form" onSubmit={saveNode}>
                            <label>عنوان<input name="title" defaultValue={detail.node.title}/></label>
                            <label>خلاصه<textarea name="summary" rows={3} defaultValue={detail.node.summary}/></label>
                            <label>محتوا<textarea name="content" rows={15} defaultValue={detail.node.content}/></label>
                            <div className="field-grid">
                              <label>وضعیت<select name="status" defaultValue={detail.node.status}><option value="active">active</option><option value="draft">draft</option><option value="archived">archived</option></select></label>
                              <label>یادداشت تغییر<input name="changeNote" placeholder="چه چیزی و چرا تغییر کرد؟"/></label>
                            </div>
                            <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setEditing(false)}>لغو</button><button className="primary-button" disabled={saving}>{saving?"ذخیره…":"ثبت نسخه جدید"}</button></div>
                          </form>}
                        </> : <div className="studio-empty document-empty">
                          <div className="empty-orb"><FileText size={24}/></div>
                          <strong>یک Node را از درخت انتخاب کن</strong>
                          <span>محتوا و جزئیات آن بدون بازشدن Drawer در همین پنل نمایش داده می‌شود.</span>
                        </div>}
                      </section>
                    </Panel>

                    <Separator className="studio-separator"><span/></Separator>

                    <Panel id="context-panel" defaultSize="25%" minSize="18%" maxSize="36%" collapsible collapsedSize="0%">
                      <aside className="studio-pane context-pane">
                        <div className="studio-pane-head">
                          <div><span className="eyebrow">CONTEXT</span><strong>نسخه‌ها و ارتباطات</strong></div>
                          {detail && <span>{detail.relations.length}</span>}
                        </div>
                        {detail ? <div className="context-scroll">
                          <section className="context-section">
                            <div className="context-title"><History size={14}/><strong>Version history</strong><span>{detail.versions.length}</span></div>
                            <div className="context-timeline">
                              {detail.versions.slice(0,12).map((v,i)=><div className="context-version" key={v.id}>
                                <i className={i===0?"latest":""}/>
                                <div><strong>v{v.version} · {v.change_note||"Update"}</strong><small>{v.actor} · {fmtDate(v.created_at)}</small></div>
                              </div>)}
                            </div>
                          </section>
                          <section className="context-section">
                            <div className="context-title"><GitBranch size={14}/><strong>Relations</strong><span>{detail.relations.length}</span></div>
                            <div className="relation-list">
                              {detail.relations.map(r=>{
                                const outgoing=r.source_node_id===detail.node.id;
                                return <div className="relation-card" key={r.id}>
                                  <span className="relation-direction">{outgoing?"→":"←"}</span>
                                  <div><strong>{r.relation_type}</strong><small>{outgoing?r.target_title:r.source_title}</small></div>
                                </div>
                              })}
                              {!detail.relations.length && <div className="context-empty">هنوز Relation مستقیمی ثبت نشده.</div>}
                            </div>
                          </section>
                          <section className="context-section context-meta">
                            <div className="context-title"><CircleDot size={14}/><strong>Metadata</strong></div>
                            <dl>
                              <div><dt>Status</dt><dd>{detail.node.status}</dd></div>
                              <div><dt>Type</dt><dd>{typeLabels[detail.node.node_type]||detail.node.node_type}</dd></div>
                              <div><dt>Updated</dt><dd>{fmtDate(detail.node.updated_at)}</dd></div>
                            </dl>
                          </section>
                        </div> : <div className="studio-empty context-empty-state">
                          <GitBranch size={22}/><strong>Context آماده نمایش است</strong><span>با انتخاب Node، تاریخچه و Relationها اینجا می‌آیند.</span>
                        </div>}
                      </aside>
                    </Panel>
                  </Group>
                </div>}
              </motion.section>
            </AnimatePresence>
          </motion.div>}

          {section==="roadmap" && <div className="page roadmap-page">
            <div className="page-heading"><div><span className="eyebrow">EXECUTION MAP</span><h2>رودمپ پروژه</h2><p>از ایده تا اجرا، همراه با وضعیت و درصد پیشرفت.</p></div><button className="primary-button" onClick={()=>setCreateKind("roadmap")}><Plus size={15}/> آیتم جدید</button></div>
            <div className="kanban">
              {(["planned","in_progress","blocked","done"] as const).map(status=><section className="kanban-col" key={status}>
                <div className="kanban-head"><div><span className={"status-dot s-"+status}/><strong>{statusMap[status]}</strong></div><span>{roadmapByStatus[status].length}</span></div>
                <div className="kanban-list">
                  {roadmapByStatus[status].map(item=><article className="roadmap-card" key={item.id}>
                    <div className="roadmap-card-top"><span className={"priority-label p-"+item.priority}>{item.priority}</span><span className="roadmap-status-mini">{statusMap[item.status]||item.status}</span></div>
                    <h4>{item.title}</h4><p>{item.description}</p>
                    <div className="progress-track"><span style={{width:item.progress+"%"}}/></div>
                    <div className="roadmap-meta"><span>{item.progress}%</span>{item.target_date&&<span><CalendarDays size={13}/>{item.target_date}</span>}</div>
                    <div className="move-actions">
                      {status!=="in_progress" && status!=="done" && <button onClick={()=>moveRoadmap(item,"in_progress")}>شروع</button>}
                      {status!=="done" && <button onClick={()=>moveRoadmap(item,"done")}>انجام شد</button>}
                    </div>
                  </article>)}
                  {!roadmapByStatus[status].length && <div className="empty-column">خالی</div>}
                </div>
              </section>)}
            </div>
          </div>}

          {section==="activity" && <div className="page activity-page">
            <div className="page-heading"><div><span className="eyebrow">IMMUTABLE ACTIVITY</span><h2>لاگ تغییرات پروژه</h2><p>ردپای تصمیم‌ها، ویرایش‌ها و تغییر وضعیت‌ها.</p></div></div>
            <section className="activity-stream panel">
              {data.activity.map((a,i)=><div className="stream-row" key={a.id}>
                <div className="stream-rail"><span className={"activity-icon action-"+a.action}>{a.action==="created"?<Plus size={14}/>:<History size={14}/>}</span>{i<data.activity.length-1&&<i/>}</div>
                <div className="stream-content"><div><strong>{a.title}</strong><span>{a.entity_type}</span></div><p>{a.details&&Object.keys(a.details).length?JSON.stringify(a.details):"بدون جزئیات اضافی"}</p><small>{a.actor} · {fmtDate(a.created_at)}</small></div>
              </div>)}
            </section>
          </div>}
        </div>
      </section>

      {section!=="knowledge" && (detailLoading||detail) && <aside className="detail-panel">
        {detailLoading ? <div className="detail-loading"><Loader2 className="spin"/>در حال خواندن نسخه‌ها…</div> : detail && <>
          <div className="detail-head"><div><span className={"tree-type type-"+detail.node.node_type}><TypeIcon type={detail.node.node_type}/></span><span>{typeLabels[detail.node.node_type]||detail.node.node_type}</span></div><button className="icon-button" onClick={()=>setDetail(null)}><X size={18}/></button></div>
          {!editing ? <div className="detail-body">
            <span className="eyebrow">KNOWLEDGE NODE</span><h2>{detail.node.title}</h2>
            <p className="detail-summary">{detail.node.summary||"بدون خلاصه"}</p>
            <div className="detail-badges"><span>v{detail.node.current_version}</span><span>{detail.node.status}</span><span>{fmtDate(detail.node.updated_at)}</span></div>
            <div className="document-content">{detail.node.content||"هنوز محتوایی ثبت نشده."}</div>
            <button className="secondary-button full" onClick={()=>setEditing(true)}>ویرایش و ثبت نسخه جدید</button>
            <div className="version-section"><div className="subhead"><History size={15}/><strong>Version history</strong><span>{detail.versions.length}</span></div>
              {detail.versions.map(v=><div className="version-row" key={v.id}><span>v{v.version}</span><div><strong>{v.change_note||"Update"}</strong><small>{v.actor} · {fmtDate(v.created_at)}</small></div></div>)}
            </div>
          </div> : <form className="detail-body edit-form" onSubmit={saveNode}>
            <label>عنوان<input name="title" defaultValue={detail.node.title}/></label>
            <label>خلاصه<textarea name="summary" rows={3} defaultValue={detail.node.summary}/></label>
            <label>محتوا<textarea name="content" rows={13} defaultValue={detail.node.content}/></label>
            <label>وضعیت<select name="status" defaultValue={detail.node.status}><option value="active">active</option><option value="draft">draft</option><option value="archived">archived</option></select></label>
            <label>یادداشت تغییر<input name="changeNote" placeholder="چه چیزی و چرا تغییر کرد؟"/></label>
            <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setEditing(false)}>لغو</button><button className="primary-button" disabled={saving}>{saving?"ذخیره…":"ثبت نسخه جدید"}</button></div>
          </form>}
        </>}
      </aside>}

      {searchOpen && <div className="overlay" onMouseDown={()=>setSearchOpen(false)}>
        <div className="search-modal" onMouseDown={e=>e.stopPropagation()}>
          <div className="search-box"><Search size={18}/><input autoFocus value={queryText} onChange={e=>setQueryText(e.target.value)} placeholder="عنوان، تصمیم، معماری، تغییر یا متن را جستجو کن…"/><kbd>ESC</kbd></div>
          <div className="search-results">
            {queryText.length<2 && <div className="search-hint"><Sparkles size={18}/><div><strong>جستجوی سراسری پروژه</strong><p>در عنوان، خلاصه و محتوای تمام Nodeهای پروژه جستجو می‌شود.</p></div></div>}
            {searchResults.map(r=><button key={r.id} onClick={()=>{setSearchOpen(false);if(r.workflow_id)setSelectedWorkflowId(r.workflow_id);setSection("knowledge");openNode(r)}}>
              <span className={"tree-type type-"+r.node_type}><TypeIcon type={r.node_type}/></span><div><strong>{r.title}</strong><p>{r.summary}</p></div><span>v{r.current_version}</span>
            </button>)}
            {queryText.length>=2&&!searchResults.length&&<div className="empty-search">نتیجه‌ای پیدا نشد.</div>}
          </div>
        </div>
      </div>}

      {createKind && <div className="overlay" onMouseDown={()=>setCreateKind(null)}>
        <form className="create-modal" onSubmit={submitCreate} onMouseDown={e=>e.stopPropagation()}>
          <div className="modal-head"><div><span className="eyebrow">CREATE</span><h3>{createKind==="project"?"پروژه جدید":createKind==="workflow"?"Workflow جدید":createKind==="roadmap"?"آیتم رودمپ جدید":"ثبت دانش جدید"}</h3></div><button type="button" className="icon-button" onClick={()=>setCreateKind(null)}><X size={18}/></button></div>
          {createKind==="project" && <>
            <label>نام پروژه<input name="name" required autoFocus placeholder="مثلاً TAKTOOK"/></label>
            <label>توضیح کوتاه<textarea name="description" rows={3} placeholder="این پروژه برای چیست؟"/></label>
          </>}
          {createKind==="workflow" && <>
            <label>نام Workflow<input name="name" required autoFocus placeholder="مثلاً Marketing"/></label>
            <label>توضیح<textarea name="description" rows={3} placeholder="دامنه و هدف این Workflow"/></label>
          </>}
          {createKind==="roadmap" && <>
            <label>عنوان<input name="title" required autoFocus placeholder="مرحله یا خروجی موردنظر"/></label>
            <label>توضیح<textarea name="description" rows={4}/></label>
            <div className="field-grid">
              <label>Workflow<select name="workflowId"><option value="">عمومی</option>{data.workflows.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
              <label>اولویت<select name="priority"><option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option></select></label>
            </div>
          </>}
          {createKind==="knowledge" && <>
            <div className="field-grid">
              <label>نوع<select name="nodeType" defaultValue="document">{Object.entries(typeLabels).map(([v,l])=><option value={v} key={v}>{l}</option>)}</select></label>
              <label>Workflow<select name="workflowId"><option value="">عمومی</option>{data.workflows.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
            </div>
            <label>عنوان<input name="title" required autoFocus placeholder="نام سند، تصمیم یا موضوع"/></label>
            <label>والد<select name="parentId"><option value="">ریشه</option>{data.nodes.map(n=><option key={n.id} value={n.id}>{n.title}</option>)}</select></label>
            <label>خلاصه<textarea name="summary" rows={2} placeholder="در یک یا دو جمله…"/></label>
            <label>محتوا<textarea name="content" rows={8} placeholder="جزئیات دقیق، تصمیم‌ها، دلیل‌ها و اطلاعات فنی…"/></label>
          </>}
          <div className="form-actions"><button type="button" className="secondary-button" onClick={()=>setCreateKind(null)}>لغو</button><button className="primary-button" disabled={saving}>{saving?"در حال ذخیره…":"ایجاد و ثبت"}</button></div>
        </form>
      </div>}
    </main>
  );
}
