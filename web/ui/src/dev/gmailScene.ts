/** Safe production-component preview. Secrets never leave this page or enter storage. */
export function installGmailScene() {
  const library=[{id:'email',name:'Gmail',description:'Connect your email for live access and remembering.',added:false},{id:'granola',name:'Granola',description:'Bring your meeting transcripts into your vault.',added:true},{id:'browser',name:'Browser extension',description:'Save pages and highlights to your vault.',added:false}];
  const accounts:any[]=[{name:'granola',account:'granola',label:'Granola',removable:false,connected:false,liveAccess:true,remembering:{enabled:true},capabilities:{read:'Read current meeting notes, transcripts and folders via Granola MCP. Does not change meetings or remember evidence.',write:null}}];
  const state=()=>({library,accounts,destination:'Sample vault (preview only)',callers:[]});
  const prior=window.fetch.bind(window);
  window.fetch=(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const path=new URL(input instanceof Request?input.url:String(input),location.href).pathname;
    if(path!=='/api/integration-accounts')return prior(input,options);
    const body=JSON.parse(typeof options?.body==='string'?options.body:'{}');
    const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
    if(!options?.method)return json(state());
    if(body.action==='install')library.find(i=>i.id===body.name)!.added=true;
    else if(body.name==='email'&&body.action==='add') {
      if(!/^[a-zA-Z0-9]{16}$/.test(String(body.password??'').replace(/ /g,'')))return json({error:'Use the sample app password: abcd efgh ijkl mnop.'},400);
      if(accounts.some(a=>a.account===body.address))return json({error:'This sample account already exists.'},400);
      accounts.push({name:'email',gmail:true,google:true,host:'imap.gmail.com',removable:true,account:body.address,label:body.address,connected:true,liveAccess:false,email:{startAt:new Date().toISOString(),attachments:false},remembering:{enabled:false},capabilities:{read:'List inbox messages, read messages and threads, and inspect current read/unread flags. Reads do not mark messages read or save evidence.',write:null}});
    } else if(body.action==='add') {
      if(typeof body.label!=='string'||!body.label.trim())return json({error:'Choose a source, account name, and API key.'},400);
      const template=accounts.find(a=>a.name===body.name)??accounts[0];
      accounts.push({...template,account:'account-'+Math.random().toString(16).slice(2,18),label:body.label.trim(),removable:true,connected:false,liveAccess:false,remembering:{enabled:false},grants:[],identity:undefined});
    } else {
      const account=accounts.find(a=>a.account===body.account);
      if(account) {
        if(body.action==='connect'||body.action==='credentials') {account.connected=true;if(body.name==='granola')account.identity={email:'sample@example.com'};}
        if(body.action==='disconnect')account.connected=false;
        if(body.action==='remove')accounts.splice(accounts.indexOf(account),1);
        if(body.action==='save'){account.liveAccess=body.liveAccess;account.remembering=body.remembering;if(account.email){account.email.attachments=body.attachments;if(body.backfillSince)account.email.backfill={since:body.backfillSince};}}
      }
    }
    return json(state());
  }) as typeof window.fetch;
}
