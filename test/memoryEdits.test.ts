import { expect, test } from 'bun:test';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { nativeVault } from './support/vault';
import { MemoryEdits } from '../lib/memoryEdits';
import { machineTools } from '../lib/run/machineTools';
test('memory recovery restores uncommitted bytes but preserves concurrent edits and arrivals',()=>{
  const root=nativeVault({files:{'memory/MEMORY.md':'Uncommitted memory','memory/topic.md':'Original topic'}});
  try {
    const edits=new MemoryEdits(root),tools=machineTools(root,'memory',false,'pi',edits);
    const write=(path:string,content:string)=>tools.find(t=>t.name==='write_memory')!.call({path,content});
    write('memory/MEMORY.md','Model edit');write('memory/topic.md','Model topic');write('memory/new.md','New');
    writeFileSync(join(root,'memory/topic.md'),'Concurrent user edit');writeFileSync(join(root,'arrival.md'),'Concurrent arrival');
    expect(()=>write('memory/topic.md','Overwrite user')).toThrow('changed outside');
    expect(()=>write('arrival.md','Overwrite arrival')).toThrow('path');
    expect(edits.rollback()).toEqual(['memory/topic.md']);
    expect(readFileSync(join(root,'memory/MEMORY.md'),'utf8')).toBe('Uncommitted memory');
    expect(readFileSync(join(root,'memory/topic.md'),'utf8')).toBe('Concurrent user edit');
    expect(readFileSync(join(root,'arrival.md'),'utf8')).toBe('Concurrent arrival');expect(existsSync(join(root,'memory/new.md'))).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});
test('edit_memory replaces exactly one passage, refuses absent or ambiguous ones, and rolls back',()=>{
  const original='Alpha beta.\nBeta gamma beta.\n',edited='Delta $& beta.\nBeta gamma beta.\n';
  const root=nativeVault({files:{'memory/topic.md':original}});
  try {
    const edits=new MemoryEdits(root),tools=machineTools(root,'memory',false,'pi',edits);
    const edit=(path:string,old_text:string,new_text:string)=>tools.find(t=>t.name==='edit_memory')!.call({path,old_text,new_text});
    const topic=()=>readFileSync(join(root,'memory/topic.md'),'utf8');
    expect(edit('memory/topic.md','Alpha','Delta $&')).toEqual({edited:'memory/topic.md'});
    expect(topic()).toBe(edited);
    expect(()=>edit('memory/topic.md','missing','x')).toThrow('exactly once');
    expect(()=>edit('memory/topic.md','beta','x')).toThrow('exactly once');
    expect(()=>edit('memory/topic.md','','x')).toThrow('must be text');
    expect(()=>edit('memory/absent.md','Alpha','x')).toThrow('exactly once');
    expect(()=>edit('log/topic.md','Alpha','x')).toThrow('only memory Markdown');
    expect(topic()).toBe(edited);
    expect(existsSync(join(root,'memory/absent.md'))).toBe(false);
    expect(edits.rollback()).toEqual([]);
    expect(topic()).toBe(original);
  } finally {rmSync(root,{recursive:true,force:true});}
});
