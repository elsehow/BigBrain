import {expect,test} from 'bun:test';
import {createServer,type Socket} from 'node:net';
import {readFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ImapFlow} from 'imapflow';
import {gitVault} from './support/vault';
import {IntegrationAccounts} from '../lib/integrationAccounts';
import {integrationToolCall} from '../lib/integrationTools';
import {headFiles} from '../lib/stageStorage';

async function server(){
 const commands:string[]=[],sockets=new Set<Socket>();
 let validity=7;
 const source=Buffer.from('From: Friend <friend@example.com>\r\nTo: me@example.com\r\nSubject: Archive thread\r\nMessage-ID: <wire@example.com>\r\n\r\nArchive context');
 const srv=createServer(socket=>{
  sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});
  socket.write('* OK test IMAP ready\r\n');let pending='';
  socket.on('data',chunk=>{
   pending+=chunk.toString();let end;
   while((end=pending.indexOf('\r\n'))>=0){
    const line=pending.slice(0,end);pending=pending.slice(end+2);
    const space=line.indexOf(' '),tag=line.slice(0,space),cmd=line.slice(space+1);
    commands.push(/^AUTHENTICATE|^LOGIN/.test(cmd)?'AUTH (synthetic)':cmd);
    const ok=()=>socket.write(`${tag} OK done\r\n`);
    if(cmd==='CAPABILITY'){socket.write('* CAPABILITY IMAP4rev1 AUTH=PLAIN SASL-IR X-GM-EXT-1 SPECIAL-USE\r\n');ok();}
    else if(/^(AUTHENTICATE|LOGIN)/.test(cmd))ok();
    else if(cmd.startsWith('LIST ')){socket.write('* LIST (\\HasNoChildren \\All) "/" "[Gmail]/All Mail"\r\n* LIST (\\HasNoChildren) "/" "INBOX"\r\n');ok();}
    else if(cmd.startsWith('LSUB '))ok();
    else if(cmd.startsWith('EXAMINE '))socket.write(`* FLAGS (\\Seen \\Answered)\r\n* 15 EXISTS\r\n* OK [UIDVALIDITY ${validity}] valid\r\n* OK [UIDNEXT 16] next\r\n${tag} OK [READ-ONLY] examined\r\n`);
    else if(cmd.startsWith('UID SEARCH ')){
     const range=/UID (\d+):(\d+|\*)/.exec(cmd);const ids=Array.from({length:15},(_,i)=>i+1).filter(i=>!range||(i>=Number(range[1])&&i<=(range[2]==='*'?15:Number(range[2]))));
     socket.write('* SEARCH '+ids.join(' ')+'\r\n');ok();
    }else if(cmd.startsWith('UID FETCH ')){
     const range=cmd.split(' ')[2]!;const ids=range.split(',').flatMap(part=>{const [lo,hi]=part.split(':').map(Number);return hi?Array.from({length:hi-lo!+1},(_,i)=>lo!+i):[lo!];});
     for(const uid of ids){
      const label=uid===1?'\\Inbox':uid===15?'\\Sent':'Project';
      let prefix=`* ${uid} FETCH (UID ${uid} FLAGS () X-GM-MSGID ${1000+uid} X-GM-THRID 123 X-GM-LABELS (${label}) RFC822.SIZE ${source.length} INTERNALDATE "25-Sep-2026 12:00:00 +0000" ENVELOPE ("Fri, 25 Sep 2026 12:00:00 +0000" "Archive thread" (("Friend" NIL "friend" "example.com")) NIL NIL ((NIL NIL "me" "example.com")) NIL NIL NIL "<${uid}@example.com>")`;
      const body=/BODY\.PEEK\[\]/.test(cmd),headers=/BODY\.PEEK\[HEADER.FIELDS \(([^)]+)\)\]/.exec(cmd);
      if(body){prefix+=` BODY[] {${source.length}}\r\n`;socket.write(prefix);socket.write(source);socket.write(')\r\n');}
      else if(headers){const h=Buffer.from('List-Id: <project.example.com>\r\n\r\n');socket.write(prefix+` BODY[HEADER.FIELDS (${headers[1]})] {${h.length}}\r\n`);socket.write(h);socket.write(')\r\n');}
      else socket.write(prefix+')\r\n');
     }ok();
    }else if(cmd==='LOGOUT'){socket.write(`* BYE done\r\n${tag} OK logout\r\n`);socket.end();}
    else if(cmd==='NOOP'||cmd==='CLOSE')ok();
    else socket.write(`${tag} BAD Unsupported fixture command\r\n`);
   }
  });
 });
 await new Promise<void>((res,rej)=>{srv.once('error',rej);srv.listen(0,'127.0.0.1',res);});
 const port=(srv.address() as {port:number}).port;
 return {commands,port,reset(){validity++;},close(){for(const s of sockets)s.destroy();srv.close();}};
}
function snapshot(root:string):string {
 const walk=(path:string):unknown=>readdirSync(path,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).map(e=>[e.name,e.isDirectory()?walk(join(path,e.name)):readFileSync(join(path,e.name),'utf8')]);
 return JSON.stringify(walk(join(root,'.spool')));
}
test('real IMAP wire: EXAMINE + PEEK, archive/thread pagination, stale cursors, zero STORE and zero live retention; real runner uses same protocol',async()=>{
 const imap=await server();const root=gitVault({files:{'vault.yaml':'{}\n','.gitignore':'.env\n.spool/\n.state/\n'}});
 try{
  const api=new IntegrationAccounts(root,{email:async()=>{}});await api.update({name:'email',action:'add',address:'me@example.com',password:'abcdefghijklmnop'});
  const options={client:()=>new ImapFlow({host:'127.0.0.1',port:imap.port,secure:false,doSTARTTLS:false,auth:{user:'me@example.com',pass:'synthetic'},logger:false})};
  const call=async(name:string,args:Record<string,unknown>)=>(await integrationToolCall(root,{kind:'pilot'},name,args,options) as any).result;
  const before=snapshot(root);
  const page=await call('email_search',{account:'me@example.com',query:'project',limit:2});
  expect(page.messages).toHaveLength(2);expect(page.next_before_uid).toBe(14);expect(page.coverage).toContain('archive');
  const next=await call('email_search',{account:'me@example.com',query:'project',limit:2,before_uid:page.next_before_uid,uidvalidity:page.uidvalidity});expect(next.messages[0].uid).toBe(13);
  const thread=await call('email_read',{ref:page.messages[0].ref});expect(thread.thread).toHaveLength(12);expect(thread.next_thread_before_uid).toBe(4);expect(thread.thread.some((m:any)=>m.labels.includes('Project'))).toBe(true);expect(thread.thread.some((m:any)=>m.labels.includes('\\Sent'))).toBe(true);
  const tail=await call('email_read',{ref:page.messages[0].ref,thread_before_uid:thread.next_thread_before_uid,thread_uidvalidity:thread.thread_uidvalidity});expect(tail.thread).toHaveLength(3);expect(tail.next_thread_before_uid).toBeNull();
  expect(snapshot(root)).toBe(before);
  imap.reset();await expect(call('email_read',{ref:page.messages[0].ref})).rejects.toThrow('identity changed');
  await expect(call('email_search',{account:'me@example.com',before_uid:14,uidvalidity:page.uidvalidity})).rejects.toThrow('identity changed');
  await api.update({name:'email',account:'me@example.com',action:'save',backfillSince:'2026-09-01'});
  const child=Bun.spawn([process.execPath,'--preload',resolve('test/support/gmailWirePreload.ts'),resolve('integrations/email/run.ts')],{cwd:root,env:{...process.env,BIGBRAIN_VAULT:root,GMAIL_WIRE_PORT:String(imap.port)},stdout:'pipe',stderr:'pipe'});
  const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(exit,err+out).toBe(0);expect(headFiles(root)).toHaveLength(15);
  expect(imap.commands.some(c=>c.startsWith('EXAMINE'))).toBe(true);expect(imap.commands.some(c=>c.includes('BODY.PEEK[]'))).toBe(true);
  expect(imap.commands.filter(c=>/^(SELECT|STORE|UID STORE|APPEND|MOVE|COPY|EXPUNGE)/.test(c))).toEqual([]);
  expect(imap.commands.filter(c=>c.includes('BODY[')&&!c.includes('BODY.PEEK'))).toEqual([]);
 }finally{imap.close();rmSync(root,{recursive:true,force:true});}
},30000);
