"use client";

import * as dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { FileText, GitBranch, CheckCircle2, BookOpen, FileClock, FolderTree } from "lucide-react";
import { useMemo } from "react";

export type GraphKnowledgeNode = {
  id:string;
  project_id:string;
  workflow_id:string|null;
  parent_id:string|null;
  node_type:string;
  title:string;
  summary:string;
  current_version:number;
  status:string;
};

export type GraphRelation = {
  id:string;
  project_id:string;
  source_node_id:string;
  target_node_id:string;
  relation_type:string;
  source_title?:string;
  target_title?:string;
  created_at:string;
};

type GraphData = {
  item:GraphKnowledgeNode;
  color:string;
  soft:string;
};

type KnowledgeFlowNode = Node<GraphData,"knowledge">;

const typePalette:Record<string,{color:string;soft:string}> = {
  folder:{color:"#657786",soft:"#EEF2F5"},
  document:{color:"#1875B7",soft:"#EAF5FF"},
  decision:{color:"#087B61",soft:"#E7F8F3"},
  architecture:{color:"#6657D4",soft:"#F0EDFF"},
  requirement:{color:"#C96C30",soft:"#FFF2E8"},
  research:{color:"#9D4FB5",soft:"#F8ECFC"},
  runbook:{color:"#A97918",soft:"#FFF7E4"},
  log:{color:"#B4436C",soft:"#FDEBF2"},
};

function TypeIcon({type}:{type:string}) {
  if(type==="folder") return <FolderTree size={14}/>;
  if(type==="decision") return <CheckCircle2 size={14}/>;
  if(type==="architecture") return <GitBranch size={14}/>;
  if(type==="research") return <BookOpen size={14}/>;
  if(type==="log") return <FileClock size={14}/>;
  return <FileText size={14}/>;
}

function KnowledgeGraphNode({data,selected}:NodeProps<KnowledgeFlowNode>) {
  const p=typePalette[data.item.node_type]||typePalette.document;
  return (
    <div
      className={"flow-knowledge-node "+(selected?"selected":"")}
      style={{"--node-color":p.color,"--node-soft":p.soft} as React.CSSProperties}
    >
      <Handle type="target" position={Position.Right} className="flow-handle"/>
      <div className="flow-node-icon"><TypeIcon type={data.item.node_type}/></div>
      <div className="flow-node-copy">
        <small>{data.item.node_type}</small>
        <strong>{data.item.title}</strong>
        <span>{data.item.summary || "بدون خلاصه"}</span>
      </div>
      <div className="flow-node-version">v{data.item.current_version}</div>
      <Handle type="source" position={Position.Left} className="flow-handle"/>
    </div>
  );
}

const nodeTypes={knowledge:KnowledgeGraphNode};

function buildLayout(items:GraphKnowledgeNode[],relations:GraphRelation[]) {
  const graph=new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(()=>({}));
  graph.setGraph({rankdir:"RL",nodesep:30,ranksep:72,marginx:24,marginy:24});

  const ids=new Set(items.map(i=>i.id));
  const edges:Edge[]=[];
  const edgeKeys=new Set<string>();

  for(const item of items) graph.setNode(item.id,{width:250,height:92});

  for(const item of items) {
    if(item.parent_id && ids.has(item.parent_id)) {
      graph.setEdge(item.parent_id,item.id);
      const id=`parent-${item.parent_id}-${item.id}`;
      edgeKeys.add(id);
      edges.push({
        id,
        source:item.parent_id,
        target:item.id,
        type:"smoothstep",
        style:{stroke:"#C8CADB",strokeWidth:1.4},
        markerEnd:{type:MarkerType.ArrowClosed,color:"#C8CADB",width:14,height:14},
      });
    }
  }

  for(const relation of relations) {
    if(!ids.has(relation.source_node_id)||!ids.has(relation.target_node_id)) continue;
    const id=`rel-${relation.id}`;
    if(edgeKeys.has(id)) continue;
    graph.setEdge(relation.source_node_id,relation.target_node_id);
    edges.push({
      id,
      source:relation.source_node_id,
      target:relation.target_node_id,
      type:"smoothstep",
      label:relation.relation_type,
      labelStyle:{fontSize:9,fill:"#696D82",fontWeight:600},
      labelBgStyle:{fill:"#FFFFFF",fillOpacity:.92},
      labelBgPadding:[5,3],
      style:{stroke:"#7568DC",strokeWidth:1.6},
      markerEnd:{type:MarkerType.ArrowClosed,color:"#7568DC",width:15,height:15},
      animated:relation.relation_type==="blocks"||relation.relation_type==="depends_on",
    });
  }

  dagre.layout(graph);

  const nodes:KnowledgeFlowNode[]=items.map(item=>{
    const pos=graph.node(item.id);
    const p=typePalette[item.node_type]||typePalette.document;
    return {
      id:item.id,
      type:"knowledge",
      position:{x:pos.x-125,y:pos.y-46},
      data:{item,color:p.color,soft:p.soft},
      selectable:true,
      draggable:false,
    };
  });

  return {nodes,edges};
}

export default function KnowledgeGraph({
  nodes,
  relations,
  selectedId,
  onOpen,
}:{
  nodes:GraphKnowledgeNode[];
  relations:GraphRelation[];
  selectedId?:string;
  onOpen:(node:GraphKnowledgeNode)=>void;
}) {
  const layout=useMemo(()=>buildLayout(nodes,relations),[nodes,relations]);

  if(!nodes.length) {
    return <div className="graph-empty"><GitBranch size={30}/><strong>هنوز چیزی برای نمایش در Graph نیست</strong><span>با ایجاد Node و Relation، نقشه ارتباطی اینجا شکل می‌گیرد.</span></div>;
  }

  return (
    <div className="knowledge-graph">
      <ReactFlow
        nodes={layout.nodes.map(n=>({...n,selected:n.id===selectedId}))}
        edges={layout.edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{padding:.18,maxZoom:1.15}}
        minZoom={.25}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        onNodeClick={(_,node)=>onOpen(node.data.item)}
        proOptions={{hideAttribution:true}}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#D9D9E7"/>
        <MiniMap
          pannable
          zoomable
          nodeColor={(n)=>String((n.data as GraphData)?.color||"#6C5CE7")}
          maskColor="rgba(247,247,252,.72)"
          className="knowledge-minimap"
        />
        <Controls showInteractive={false} position="bottom-left"/>
      </ReactFlow>
      <div className="graph-legend">
        <span><i className="legend-parent"/>Hierarchy</span>
        <span><i className="legend-relation"/>Relation</span>
      </div>
    </div>
  );
}
