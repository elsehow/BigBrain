import { expect, test } from "bun:test";
import { GENERAL_WORKSPACE, workspaceMembershipIndex } from "../web/ui/src/lib/workspaceMembership";
const memories=[{id:"research",path:"memory/research.md"},{id:"software",path:"memory/software.md"},{id:"root",path:"MEMORY.md"}];
const category=(memory:string|null)=>({memory,inputKey:"key",reason:"Task",model:"quick",assignedAt:new Date().toISOString()});
test("each agent has exactly one semantic home, independent of attachment votes",()=>{
  const agents=[{id:"a",context:["research"],category:category("software")},{id:"b",category:category("memory/research.md")}];
  const result=workspaceMembershipIndex(memories).forAgents(agents);
  expect([...result.get("a")!]).toEqual(["software"]); expect([...result.get("b")!]).toEqual(["research"]);
});
test("unclassified, unmatched, deleted and root assignments are discoverable in General",()=>{
  const agents=[{id:"new"},{id:"general",category:category(null)},{id:"deleted",category:category("gone")},{id:"root",category:category("root")}];
  for(const group of workspaceMembershipIndex(memories).forAgents(agents).values()) expect([...group]).toEqual([GENERAL_WORKSPACE]);
  expect([...workspaceMembershipIndex([]).forAgents([{id:"a"}]).get("a")!]).toEqual([GENERAL_WORKSPACE]);
});
