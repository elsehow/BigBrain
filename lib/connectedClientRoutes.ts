import { LocalClients } from "./localClients";
import { ConnectedClients } from "./connectedClients";
import { json, readBody, type Route } from "./httpx";
export function connectedClientRoutes(clients:ConnectedClients):Route[] {
  const local = new LocalClients(clients);
  return [
    {method:"GET",path:"/api/connected-clients",handler:({res})=>json(res,200,{clients:clients.list(),local:local.list()})},
    {method:"POST",path:"/api/connected-clients",handler:async({req,res})=>{
      if(req.headers["content-type"]?.split(";")[0]?.trim()!=="application/json")return json(res,415,{error:"JSON required."});
      if(req.headers.origin){try{const o=new URL(req.headers.origin);if(o.protocol!=="http:"||o.host!==req.headers.host)throw Error();}catch{return json(res,403,{error:"The app's own origin is required."});}}
      try {
        const value=JSON.parse(await readBody(req,12000));
        if(value.action==="local")return json(res,200,{local:local.set(value.kind,value.enabled)});
        if(value.action==="create")return json(res,200,clients.create({name:value.name,kind:value.kind}));
        if(value.action==="replace")return json(res,200,clients.replace(value.id));
        if(value.action==="setup")return json(res,200,clients.setup(value.id));
        if(value.action==="reconnect")return json(res,200,clients.reconnect(value.id));
        if(value.action==="revoke"){clients.revoke(value.id);return json(res,200,{ok:true});}
        throw Error("Unknown client action.");
      }catch(e){json(res,400,{error:e instanceof Error?e.message:"Client setup failed."});}
    }},
  ];
}
