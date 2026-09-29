import type {IncomingMessage,ServerResponse} from 'node:http';
import {json,readBody} from './httpx';
import {allowVaultRequest,vaultIdentity} from './vaultBoundary';
import {connectionStorePath} from './sharedConnections';
import {jevSettingsStatus,saveJevKey} from './jevSettings';
import {evaluateJev} from './sharedJev';
export async function jevSettingsApi(req:IncomingMessage,res:ServerResponse,root:string,validate:typeof evaluateJev=evaluateJev) {
 if(new URL(req.url??'/','http://localhost').pathname!=='/api/models/jev')return false;
 if(!allowVaultRequest(req,res,vaultIdentity(root)))return true;
 const store=connectionStorePath();
 try{
  if(req.method==='GET')json(res,200,jevSettingsStatus(store));
  else if(req.method==='DELETE'){saveJevKey(store,null);json(res,200,jevSettingsStatus(store));}
  else if(req.method==='POST'){
   const body=JSON.parse(await readBody(req,10000));
   if(typeof body.apiKey!=='string'||!body.apiKey.trim()||body.apiKey.length>8192||/[\r\n]/.test(body.apiKey))throw Error('Enter a valid Jev API key.');
   // Validate with invented text, never vault content. Keep the old key on failure.
   await validate(body.apiKey.trim(),'Sources about gardening.',[],{title:'Gardening',body:'Plant seedlings in prepared soil and water them.'});
   saveJevKey(store,body.apiKey);json(res,200,jevSettingsStatus(store));
  }else json(res,405,{error:'Method not allowed'});
 }catch{json(res,400,{error:'Could not update Jev. Check the API key and connection, then try again.'});}
 return true;
}
