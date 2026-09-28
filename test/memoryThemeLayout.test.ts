import { expect, test } from 'bun:test';
import { memoryThemeLayout } from '../web/ui/src/lib/memoryThemeLayout';
test('theme positions are deterministic, spread memories, and keep shared notes between themes', () => {
  const nodes = [{id:'a',group:'memory',x:0,y:0}, {id:'b',group:'memory',x:0,y:0}, {id:'shared',group:'source',x:0,y:0}];
  const adj = [[2],[2],[0,1]];
  const before = structuredClone(nodes), result = memoryThemeLayout(nodes, adj);
  expect(memoryThemeLayout(nodes, adj)).toEqual(result);
  expect(nodes).toEqual(before);
  expect(Math.hypot(result[0]!.x-result[1]!.x,result[0]!.y-result[1]!.y)).toBeGreaterThan(200);
  const center = {x:(result[0]!.x+result[1]!.x)/2,y:(result[0]!.y+result[1]!.y)/2};
  expect(Math.hypot(result[2]!.x-center.x,result[2]!.y-center.y)).toBeLessThan(120);
});
test('without memories the existing layout is preserved', () => {
  expect(memoryThemeLayout([{id:'s',group:'source',x:23,y:-51}], [[]])).toEqual([{x:23,y:-51}]);
});

test('ordinary nodes leave room around memory markers and labels, including shared notes', () => {
  const nodes = [{id:'a',group:'memory',x:0,y:0}, {id:'b',group:'memory',x:0,y:0}, ...Array.from({length:40}, (_,i) => ({id:`n${i}`,group:'source',x:0,y:0}))];
  const adj = [nodes.slice(2).map((_,i)=>i+2), nodes.slice(2).map((_,i)=>i+2), ...nodes.slice(2).map(()=>[0,1])];
  const positions = memoryThemeLayout(nodes, adj);
  for (const node of positions.slice(2)) for (const anchor of positions.slice(0,2))
    expect(Math.hypot((node.x-anchor.x)/140,(node.y-anchor.y-15)/95)).toBeGreaterThanOrEqual(1);
});
