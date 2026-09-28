/** Test-only transport substitution. Production runner + real ImapFlow commands. */
import {mock} from 'bun:test';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {ImapFlow}=require('../../node_modules/imapflow/lib/imap-flow.js');
class LocalImap extends ImapFlow {
 constructor(options:any){super({...options,host:'127.0.0.1',port:Number(process.env.GMAIL_WIRE_PORT),secure:false,doSTARTTLS:false});}
}
mock.module('imapflow',()=>({ImapFlow:LocalImap}));
