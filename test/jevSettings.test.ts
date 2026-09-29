import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {optionalJevKey,saveJevKey,jevSettingsStatus} from '../lib/jevSettings';
import {jevSettingsApi} from '../lib/jevSettingsApi';
import {vaultIdentity} from '../lib/vaultBoundary';
test('optional Jev key storage stays private and explicit removal overrides legacy configuration',()=>{
 const home=mkdtempSync(join(tmpdir(),'jev-settings-')),store=join(home,'connections.json');
 try{
  writeFileSync(join(home,'.env'),'TYPESAFE_API_KEY=example-legacy-key\n');
  expect(optionalJevKey(store)).toBe('example-legacy-key');
  saveJevKey(store,'example-new-key');expect(optionalJevKey(store)).toBe('example-new-key');
  expect(jevSettingsStatus(store)).toEqual({configured:true,evaluator:'jev'});
  expect(statSync(join(home,'jev-settings.json')).mode&0o777).toBe(0o600);
  saveJevKey(store,null);expect(optionalJevKey(store)).toBeUndefined();
  expect(jevSettingsStatus(store)).toEqual({configured:false,evaluator:'quick'});
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('Jev settings API validates before saving, never returns secrets, and respects vault boundaries',async()=>{
 const home=mkdtempSync(join(tmpdir(),'jev-api-')),store=join(home,'connections.json');
 const before=process.env.BIGBRAIN_SHARED_CONNECTIONS;process.env.BIGBRAIN_SHARED_CONNECTIONS=store;
 saveJevKey(store,null);let validations=0;
 const server=createServer(async(req,res)=>{await jevSettingsApi(req,res,home,async(key,_rule,_entities,source)=>{
  validations++;expect(source.title).toBe('Gardening');
  if(key==='invalid-example-key')throw Error('private server detail: '+key);
  return {include:true,relevant:1,model:'example',inputTokens:1};
 });});
 try{
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as {port:number}).port}/api/models/jev`;
  const post=(key:string)=>fetch(url,{method:'POST',body:JSON.stringify({apiKey:key})});
  expect(await (await post('example-secret')).json()).toEqual({configured:true,evaluator:'jev'});
  const failed=await post('invalid-example-key');expect(failed.status).toBe(400);expect(await failed.text()).not.toContain('invalid-example-key');expect(optionalJevKey(store)).toBe('example-secret');
  expect(await(await fetch(url)).json()).toEqual({configured:true,evaluator:'jev'});
  const stale=await fetch(url,{method:'DELETE',headers:{'x-bigbrain-vault':'stale'}});expect(stale.status).toBe(409);expect(optionalJevKey(store)).toBe('example-secret');
  expect(await(await fetch(url,{method:'DELETE',headers:{'x-bigbrain-vault':vaultIdentity(home)}})).json()).toEqual({configured:false,evaluator:'quick'});
  expect(validations).toBe(2);
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));if(before===undefined)delete process.env.BIGBRAIN_SHARED_CONNECTIONS;else process.env.BIGBRAIN_SHARED_CONNECTIONS=before;rmSync(home,{recursive:true,force:true});}
});
