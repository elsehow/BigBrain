import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { nativeVault, insertion } from "./support/vault";
import { assertionEntityId, appendAssertionEvent, createAssertionEvent } from "../lib/assertionLog";
import { memoryCategoryCatalogue } from "../lib/memoryCategories";
import { invalidateGraphCaches } from "../lib/graphCache";
import { PilotCategories } from "../lib/pilotCategories";
import { newPilotChatSession } from "../lib/pilotChatTypes";
import { PILOT_CATEGORY_GRAPH_VERSION, rankPilotCategories } from "../lib/pilotCategoryGraph";
import type { Graph } from "../lib/graph";

const roots: string[] = [], workers: PilotCategories[] = [];
afterEach(() => { workers.splice(0).forEach(w => w.close()); roots.splice(0).forEach(r => rmSync(r, {recursive:true,force:true})); });
const graph = (): Graph => ({hash:"v1",nodes:[
  {id:"research",path:"entities/research.md",title:"Research project",group:"entity",degree:1},
  {id:"software",title:"Personal app",group:"entity",degree:1},
  {id:"memory/research",path:"memory/research.md",title:"Research",group:"memory",degree:1},
  {id:"memory/software",path:"memory/software.md",title:"Software",group:"memory",degree:1},
],edges:[{source:"research",target:"memory/research"},{source:"software",target:"memory/software"}]});
function fixture() {
  const root = nativeVault({files:{"vault.yaml":"{}"}}); roots.push(root);
  const s = newPilotChatSession(["research"]); s.title="Research question";
  s.messages.push({id:"m1",at:s.created,role:"user",text:"Compare forecasting methods"});
  let current = graph(), writes=0, reads=0, clock=Date.now();
  let reader: (()=>Promise<Graph>) | undefined;
  const published: string[] = [];
  const worker = new PilotCategories(root, {list:()=>[s],publish:(session,value)=>{writes++;published.push(value.memory ?? "general");session.category=value;}}, {
    graph:async()=>{reads++;return reader ? reader() : current;},now:()=>clock,debounceMs:100_000,
  }); workers.push(worker);
  return {s,worker,writes:()=>writes,reads:()=>reads,published,setGraph:(v:Graph)=>{current=v;},setReader:(v:()=>Promise<Graph>)=>{reader=v;},advance:()=>{clock+=60_001;}};
}
test("full memory catalogue excludes root and refreshes after text-only changes", async()=>{
  const root=nativeVault({files:{"MEMORY.md":"# Memory\nRoot index", "memory/research.md":"# Research\nOriginal scope"}}); roots.push(root);
  const first=await memoryCategoryCatalogue(root);
  expect(first.memories).toHaveLength(1); expect(first.memories[0]!.text).toContain("Original scope");
  expect(await memoryCategoryCatalogue(root)).toBe(first);
  writeFileSync(join(root,"memory/research.md"),"# Research\nRevised scope with the same graph"); invalidateGraphCaches(root);
  const next=await memoryCategoryCatalogue(root);
  expect(next.key).not.toBe(first.key); expect(next.memories[0]!.text).toContain("Revised scope");
  expect(JSON.parse(readFileSync(join(root,".state/memory-categories.json"),"utf8")).key).toBe(next.key);
  rmSync(join(root,"memory/research.md")); invalidateGraphCaches(root);
  expect((await memoryCategoryCatalogue(root)).memories).toHaveLength(0);
});

test("first user message classifies while working; drafts and assistants alone do not",async()=>{
  const f=fixture();f.s.messages=[];f.s.phase="working";
  f.worker.changed(f.s);await f.worker.refresh();expect(f.writes()).toBe(0);
  f.s.messages.push({id:"a",at:f.s.created,role:"assistant",text:"Ready"});
  f.worker.changed(f.s);await f.worker.flush();expect(f.writes()).toBe(0);
  f.s.messages.push({id:"u",at:f.s.created,role:"user",text:"Start"});
  f.worker.changed(f.s);await f.worker.flush();expect(f.s.category?.memory).toBe("memory/research");
  expect(f.s.category?.model).toBe(PILOT_CATEGORY_GRAPH_VERSION);
});
test("status, title, prose and heartbeat writes reuse placement; attachments trigger a new placement",async()=>{
  const f=fixture();await f.worker.refresh();expect(f.writes()).toBe(1);
  f.s.title="A different title";f.s.live="stream";f.s.draft="unsent";
  f.s.messages.push({id:"m2",at:f.s.created,role:"user",text:"Another message"});
  f.worker.changed(f.s);await f.worker.flush();await f.worker.refresh();expect(f.writes()).toBe(1);
  f.s.context=["software"];f.worker.changed(f.s);await f.worker.flush();
  expect(f.s.category?.memory).toBe("memory/software");expect(f.writes()).toBe(2);
});
test("graph-only change is picked up by maintenance even during a running turn",async()=>{
  const f=fixture();await f.worker.refresh();f.s.phase="working";
  f.setGraph({...graph(),hash:"v2",edges:[{source:"research",target:"memory/software"},{source:"software",target:"memory/research"}]});
  await f.worker.refresh();expect(f.s.category?.memory).toBe("memory/software");
  await f.worker.refresh();expect(f.writes()).toBe(2);
});
test("an older model assignment is replaced by the graph result without calling Quick",async()=>{
  const f=fixture();f.s.category={memory:null,inputKey:"old",model:"quick",assignedAt:f.s.created,reason:"No match"};
  await f.worker.refresh();expect(f.s.category?.memory).toBe("memory/research");expect(f.s.category?.model).toBe(PILOT_CATEGORY_GRAPH_VERSION);
});
test("missing evidence and ties retain valid placement; a fresh unresolved session stays uncategorized",async()=>{
  const f=fixture();f.s.context=[];await f.worker.refresh();expect(f.s.category?.memory).toBeNull();
  f.s.context=["research"];await f.worker.refresh();expect(f.s.category?.memory).toBe("memory/research");
  f.s.context=["missing"];await f.worker.refresh();expect(f.s.category?.memory).toBe("memory/research");
  f.s.context=["research","software"];await f.worker.refresh();expect(f.s.category?.memory).toBe("memory/research");
  expect(f.s.category?.reason).toContain("Kept");
});
test("deleted memory cannot remain an assignment when no signal is available",async()=>{
  const f=fixture();await f.worker.refresh();f.s.context=[];
  f.setGraph({...graph(),hash:"deleted",nodes:graph().nodes.filter(n=>n.id!=="memory/research")});
  await f.worker.refresh();expect(f.s.category?.memory).toBeNull();
});
test("attachment changes during graph reads discard the stale result",async()=>{
  const f=fixture();let reads=0;let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  f.setReader(async()=>{if(++reads===2)await gate;return graph();});
  const pending=f.worker.refresh();await Bun.sleep(5);f.s.context=["software"];f.worker.changed(f.s);release();await pending;
  expect(f.published).toEqual(["memory/software"]);
});
test("graph changes during reads discard the stale result",async()=>{
  const f=fixture();let reads=0;
  const next={...graph(),hash:"new",edges:[{source:"research",target:"memory/software"}]};
  f.setReader(async()=>++reads===1?graph():next);
  await f.worker.refresh();expect(f.published).toEqual(["memory/software"]);
});
test("graph read failure keeps placement and retries after backoff; closing cancels publication",async()=>{
  const f=fixture();await f.worker.refresh();const prior=f.s.category;
  f.s.context=["software"];f.setReader(async()=>{throw new Error("offline");});
  await f.worker.refresh();const reads=f.reads();await f.worker.refresh();expect(f.reads()).toBe(reads);expect(f.s.category).toBe(prior);
  f.advance();f.setReader(async()=>graph());await f.worker.refresh();expect(f.s.category?.memory).toBe("memory/software");
  const g=fixture();let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  g.setReader(async()=>{await gate;return graph();});const pending=g.worker.refresh();g.worker.close();release();await pending;expect(g.writes()).toBe(0);
});
test("deactivated sessions are skipped",async()=>{
  const f=fixture();f.s.deactivatedAt=f.s.created;await f.worker.refresh();expect(f.writes()).toBe(0);
});
test("maintenance persists categories without changing activity or attachments; restart reuses the result",async()=>{
  const {PilotChats}=await import("../lib/pilotChat");
  const root=nativeVault({files:{"vault.yaml":"{}"}});roots.push(root);
  const options={graph:()=>graph().nodes,categories:{graph:async()=>graph()}};
  const chats=new PilotChats(root,options),s=chats.create(["research"]);s.phase="answered";
  s.messages.push({id:"m1",at:s.created,role:"user",text:"Compare forecasts"});
  const updated=s.updated,activity=s.lastActivityAt,context=[...s.context];
  chats.startMaintenance();
  try {for(let i=0;i<100&&!s.category;i++)await Bun.sleep(5);
    expect(s.category?.memory).toBe("memory/research");expect(s.updated).toBe(updated);expect(s.lastActivityAt).toBe(activity);expect(s.context).toEqual(context);
  }finally{chats.close();}
  const assignment=s.category,restored=new PilotChats(root,options);restored.startMaintenance();
  try{await Bun.sleep(30);expect(restored.get(s.id)?.category).toEqual(assignment);}finally{restored.close();}
});

test("source-to-memory shortcuts do not beat the actual entity neighborhood",()=>{
  const g=graph();g.nodes.push({id:"source",group:"source",title:"Broad conversation",degree:2});
  g.edges.push({source:"research",target:"source",weight:100},{source:"source",target:"memory/software",weight:100});
  const result=rankPilotCategories(g,{id:"agent",context:["entities/research.md","research"]});
  expect(result.anchors).toEqual(["research"]);expect(result.winners).toEqual(["memory/research"]);
});
test("captured self-evidence and the root memory index cannot influence placement",()=>{
  const g=graph();g.nodes.push({id:"source:self",path:"log/self.json",group:"source",title:"Self",degree:1},
    {id:"memory/MEMORY.md",title:"Index",group:"memory",degree:1});
  g.edges.push({source:"software",target:"source:self",weight:100},{source:"research",target:"memory/MEMORY.md",weight:100});
  const result=rankPilotCategories(g,{id:"agent",context:["source:self"],ingestions:[{through:1,sourceId:"self",insertionId:"self",path:"log/self.json"}]});
  expect(result.winners).toEqual([]);expect(result.memories.map(m=>m.id)).not.toContain("memory/MEMORY.md");
});

test("default worker uses the real scratch-vault graph and reclassifies after memory links change",async()=>{
  const entity={id:assertionEntityId("Atlas"),label:"Atlas"};
  const source=insertion({body:"Atlas is a research project."});
  const link=`[[projection/entities/${entity.id}.md|Atlas]]`;
  const root=nativeVault({insertions:[source],files:{"memory/research.md":`# Research\n${link}`,"memory/software.md":"# Software"}});roots.push(root);
  appendAssertionEvent(root,createAssertionEvent({text:`[[${entity.id}|Atlas]] is a research project.`,entities:[entity],
    citations:[{insertion_id:source.id,quotes:[source.body]}],author:{kind:"model",id:"test",invocation_id:"test"},
    confidence:"direct",created_at:"2026-09-24T12:00:00.000Z",produced_by:{procedure:"test",version:"1"}},new Map([[source.id,source]])));
  const s=newPilotChatSession([entity.id]);s.messages.push({id:"u",role:"user",at:s.created,text:"Work on Atlas"});
  const worker=new PilotCategories(root,{list:()=>[s],publish:(session,category)=>{session.category=category;}});workers.push(worker);
  await worker.refresh();expect(s.category?.memory).toBe("memory/research.md");
  writeFileSync(join(root,"memory/research.md"),"# Research");writeFileSync(join(root,"memory/software.md"),`# Software\n${link}`);invalidateGraphCaches(root);
  await worker.refresh();expect(s.category?.memory).toBe("memory/software.md");
});
