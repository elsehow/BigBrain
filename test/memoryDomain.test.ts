import { expect, test } from "bun:test";
import { memoryDomain, memoryDomainDepth, memoryDomainEdge } from "../web/ui/src/lib/memoryDomain";
// 0 memory; 1,2 direct; 3 shared second; 4 single second; 5 third.
const adj = [[1,2], [0,3,4], [0,3], [1,2,5], [1], [3]];
test("two-hop domain ranks shared connections without expanding into third hops", () => {
  const domain = memoryDomain(adj, 0);
  expect([...domain.direct]).toEqual([1,2]);
  expect([...domain.second]).toEqual([[3,2],[4,1]]);
  expect(adj.map((_, i) => memoryDomainDepth(domain,i,-1,adj))).toEqual([0,-12,-12,-165,-224,-240]);
});
test("hover raises only the second-degree item and its paths to the memory", () => {
  const domain = memoryDomain(adj,0);
  expect(adj.map((_,i)=>memoryDomainDepth(domain,i,4,adj))).toEqual([0,0,-12,-165,0,-240]);
});
test("excluded nodes neither appear nor act as bridges", () => {
  const domain = memoryDomain(adj,0,new Set([1]));
  expect([...domain.direct]).toEqual([2]);
  expect([...domain.second]).toEqual([[3,1]]);
});

test("hovering a direct neighbor reveals its second-degree items, not the whole domain", () => {
  const domain = memoryDomain(adj,0);
  expect(adj.map((_,i)=>memoryDomainDepth(domain,i,2,adj))).toEqual([0,-12,0,-60,-224,-240]);
});
test("only memory spokes persist; hover reveals local paths and never third hops", () => {
  const domain = memoryDomain(adj,0);
  expect(memoryDomainEdge(domain,0,1,-1)).toBe(1);
  expect(memoryDomainEdge(domain,1,3,-1)).toBe(0);
  expect(memoryDomainEdge(domain,1,3,1)).toBe(1);
  expect(memoryDomainEdge(domain,1,3,3)).toBe(1);
  expect(memoryDomainEdge(domain,1,4,3)).toBe(0);
  expect(memoryDomainEdge(domain,3,5,3)).toBe(0);
});
