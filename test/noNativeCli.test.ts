import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
test('setup, discovery, diagnostics, fixed roles, Pilot, workers and restart need no native CLI', async()=>{
  const home=mkdtempSync(join(tmpdir(),'bb-no-cli-')), bin=join(home,'.local','bin'), marker=join(home,'native-called');
  mkdirSync(bin,{recursive:true});
  for(const name of ['claude','codex']) writeFileSync(join(bin,name),'#!/bin/sh\nprintf called >> "$BB_POISON_MARKER"\nexit 97\n',{mode:0o755});
  try {
    const child=Bun.spawn([process.execPath,resolve('test/support/noNativeCli.ts')],{env:{...process.env,HOME:home,PI_CODING_AGENT_DIR:join(home,'.pi','agent'),PATH:`${bin}:${process.env.PATH}`,BB_POISON_MARKER:marker},stdout:'pipe',stderr:'pipe'});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({code,stderr}).toEqual({code:0,stderr:''});
    expect(stdout).toContain('App workflows completed without native CLIs');
    expect(existsSync(marker)).toBe(false);
  } finally { rmSync(home,{recursive:true,force:true}); }
},20000);
