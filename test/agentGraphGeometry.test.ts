import {expect,test} from 'bun:test';
import {graphGeometryKey} from '../web/ui/src/lib/graph/status';
import type {GraphData} from '../web/ui/src/lib/types';
test('native agent status changes retain GPU geometry while square and Pilot shapes remain distinct',()=>{
 const graph={nodes:[{id:'agent',title:'Task',group:'agent',degree:1,pilotPhase:'working',agentState:'running'}],edges:[]} as GraphData;
 const key=graphGeometryKey(graph);
 const changed=structuredClone(graph);changed.nodes[0]!.pilotPhase='idle';changed.nodes[0]!.agentState='stopped';
 expect(graphGeometryKey(changed)).toBe(key);
 changed.nodes[0]!.group='pilot';expect(graphGeometryKey(changed)).not.toBe(key);
});
