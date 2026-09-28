import { IntegrationAccounts } from './integrationAccounts';
import { json, readBody, type Route } from './httpx';
export function integrationAccountRoutes(accounts:IntegrationAccounts):Route[]{return [
 {method:'GET',path:'/api/integration-accounts',handler:({res})=>{try{json(res,200,accounts.list());}catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not load accounts.'});}}},
 {method:'POST',path:'/api/integration-accounts',handler:async({req,res})=>{
  if(req.headers['content-type']?.split(';')[0]?.trim()!=='application/json')return json(res,415,{error:'JSON required.'});
  if(req.headers.origin){try{const o=new URL(req.headers.origin);if(o.protocol!=='http:'||o.host!==req.headers.host)throw Error();}catch{return json(res,403,{error:"The app's own origin is required."});}}
  try{json(res,200,await accounts.update(JSON.parse(await readBody(req,32000))));}catch(e){json(res,400,{error:e instanceof Error?e.message:'Could not update account.'});}
 }},
];}
