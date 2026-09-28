import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withProjectionWrite } from "../lib/projectionWriteLock";
const modulePath=join(import.meta.dir,"../lib/projectionWriteLock.ts");
test("projection critical sections are reentrant and release after an exception",()=>{
  const root=mkdtempSync(join(tmpdir(),"projection-lock-"));
  try {
    expect(()=>withProjectionWrite(root,()=>withProjectionWrite(root,()=>{throw Error("fixture");}))).toThrow("fixture");
    expect(withProjectionWrite(root,()=>42)).toBe(42);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("competing writers serialize and an abruptly killed owner releases the lock",async()=>{
  const root=mkdtempSync(join(tmpdir(),"projection-lock-"));
  const script=join(root,"writer.ts"),log=join(root,"log");
  writeFileSync(script,`import { appendFileSync } from 'node:fs';
import { withProjectionWrite } from ${JSON.stringify(modulePath)};
const [root,id,delay]=process.argv.slice(2);
withProjectionWrite(root!,()=>{appendFileSync(root+'/log',id+' start\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(delay));appendFileSync(root+'/log',id+' end\\n');});`);
  const children:ReturnType<typeof Bun.spawn>[]=[];
  const run=(id:string,delay:number)=>{const p=Bun.spawn([process.execPath,script,root,id,String(delay)],{stdout:'ignore',stderr:'pipe'});children.push(p);return p;};
  try {
    const owner=run('owner',30000);
    for(let i=0;i<500&&!existsSync(log);i++)await Bun.sleep(5);
    expect(readFileSync(log,'utf8')).toBe('owner start\n');
    const waiters=Array.from({length:8},(_,i)=>run(String(i),10));
    await Bun.sleep(40);expect(readFileSync(log,'utf8')).toBe('owner start\n');
    owner.kill('SIGKILL');await owner.exited;
    for(const p of waiters){const [status,error]=await Promise.all([p.exited,new Response(p.stderr).text()]);expect({status,error}).toEqual({status:0,error:''});}
    const lines=readFileSync(log,'utf8').trim().split('\n').slice(1);expect(lines).toHaveLength(16);
    for(let i=0;i<lines.length;i+=2)expect(lines[i+1]).toBe(lines[i]!.replace('start','end'));
  }finally{for(const p of children)p.kill();await Promise.all(children.map(p=>p.exited));rmSync(root,{recursive:true,force:true});}
},10000);
