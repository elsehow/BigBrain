/** Child-process IMAP fixture: the real runner still resolves/initializes its vault. */
import { mock } from 'bun:test';
import { readFileSync, appendFileSync } from 'node:fs';
const config=JSON.parse(readFileSync(process.env.GMAIL_TEST_FIXTURE!,'utf8'));
const record=(op:string,args?:unknown)=>appendFileSync(process.env.GMAIL_TEST_TRACE!,JSON.stringify({op,args})+'\n');
const source=(uid:number)=>Buffer.from(`From: Friend <friend@example.com>\r\nTo: me@example.com\r\nSubject: Message ${uid}\r\nMessage-ID: <${config.sameMessageId?'same':uid}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="boundary"\r\n\r\n--boundary\r\nContent-Type: text/plain\r\n\r\nDecision ${uid}.\r\n--boundary\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="file.txt"\r\n\r\nAttachment contents\r\n--boundary--\r\n`);
class Client {
 capabilities=new Set(['X-GM-EXT-1']);usable=true;
 mailbox={uidValidity:BigInt(config.validity??1),uidNext:config.count+1,exists:config.count,readOnly:true};
 on(){} async connect(){record('connect');}async logout(){record('logout');}close(){}
 async list(){return [{path:'[Gmail]/All Mail',specialUse:'\\All'}];}
 async getMailboxLock(path:string,opts:any){if(!opts?.readOnly)throw Error('Runner did not request read-only');record('EXAMINE',{path});return {release(){}};}
 async search(q:any){record('search',q);const min=q.uid?Number(q.uid.split(':')[0]):1;return Array.from({length:config.count},(_,i)=>i+1).filter(uid=>uid>=min);}
 async *fetch(uids:number[],query:any){
  record(query.source?'PEEK':'headers',{uids,query});
  for(const uid of uids){
   if(config.missingHeader===uid&&!query.source)continue;
   if(config.failBody===uid&&query.source)continue;
   yield {uid,seq:uid,emailId:String(config.identities?.[uid]??((config.idBase??100000)+uid)),threadId:'555',labels:new Set(config.labels??['\\Inbox','Project']),size:300,
    internalDate:new Date(config.internalDate??'2026-09-25T12:00:00Z'),headers:Buffer.from(''),
    envelope:{from:[{address:'friend@example.com',name:'Friend'}],to:[{address:'me@example.com'}],subject:`Message ${uid}`,messageId:config.noMessageId?'':`<${config.sameMessageId?'same':uid}@example.com>`,date:new Date('2026-09-25T12:00:00Z')},
    ...(query.source?{source:source(uid)}:{})};
  }
 }
}
mock.module('imapflow',()=>({ImapFlow:Client}));
