// Fictional inbox triage fixture, kept out of production builds.
import {mount} from 'svelte';
import Base from '../components/Base.svelte';
import {app} from '../lib/store.svelte';
import {chat} from '../lib/pilotChat.svelte';
import {newPilotChatSession,type PilotChatSession} from '../../../../lib/pilotChatTypes';
import {BRIEFINGS,installFakeApi,setVaultState,type VaultState} from './fakeApi';
import '../design/tokens.css';
import '../app.css';
import './typeStudy.css';

if(import.meta.env.DEV){
  installFakeApi();navigator.sendBeacon=()=>true;
  const fixture:VaultState={...BRIEFINGS.ready!,label:'Inbox triage',recent:[],graph:{hash:'inbox-demo-36',nodes:[],edges:[]},notes:{},sourceReadStates:[]};
  const groups=['Work inbox','Personal inbox','Research inbox','Slack · product','Slack · engineering','Slack · research'];
  const priorities=[
    {id:'memory/inbox-0-0.md',title:'Approve the launch date',text:'Alex: Can you approve Thursday’s launch date by 2pm? We need your decision before we notify the team.'},
    {id:'memory/inbox-3-0.md',title:'Unblock Maya',text:'Maya in #product: Which onboarding approach are we taking? I’m blocked on your decision before I can finish the mockups.'},
    {id:'memory/inbox-2-0.md',title:'Review the interview plan',text:'Research team: Please review the customer interview plan before tomorrow’s first session.'}
  ];
  for(let c=0;c<6;c++){
    const a=c*Math.PI/3,cx=Math.cos(a)*340,cy=Math.sin(a)*220,hub=`memory/inbox-group-${c}.md`;
    fixture.graph.nodes.push({id:hub,path:hub,title:groups[c],group:'memory',degree:8,x:cx,y:cy});
    fixture.graph.edges.push({source:hub,target:`memory/inbox-group-${(c+1)%6}.md`});
    fixture.notes![hub]={path:hub,content:`# ${groups[c]}\n\n6 unread messages.`};
    for(let n=0;n<6;n++){
      const id=`memory/inbox-${c}-${n}.md`,theta=n*2.39996323+c*.6,r=28+Math.sqrt(n/6)*120;
      const priority=priorities.find(p=>p.id===id);
      const title=priority?.title??`${groups[c]} · ${['Weekly update','Project thread','FYI','Discussion','Newsletter'][n%5]} ${n+1}`;
      const readState={unread:true,writable:true,status:'synced' as const,provider:c<3?'email':'slack'};
      fixture.graph.nodes.push({id,path:id,title,group:'source',degree:1,x:cx+Math.cos(theta)*r,y:cy+Math.sin(theta)*r*.8,readState});
      fixture.graph.edges.push({source:hub,target:id});
      fixture.sourceReadStates!.push({path:id,title,readState});
      fixture.notes![id]={path:id,content:`# ${title}\n\n${priority?.text??'An informational update. No reply or decision requested.'}`,sourceAssertions:[]};
    }
  }
  fixture.noteSummary=(selected)=>priorities.find(p=>selected.includes(p.id))?.text??'An informational update. No reply or decision requested.';
  setVaultState(fixture);chat.sessions=[];app.pilotAutofocus=true;
  const sessions:PilotChatSession[]=[];
  const fake=window.fetch;
  window.fetch=(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    if(!url.pathname.startsWith('/api/pilot/chat'))return fake(input,options);
    const action=url.pathname.slice('/api/pilot/chat'.length),body=JSON.parse(String(options?.body??'{}'));
    const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
    if(!action)return json({sessions});
    if(action==='/notifications')return json({notifications:[]});
    if(action==='/presence')return json({ok:true});
    if(action==='/create'){const s=newPilotChatSession(fixture.graph.nodes.filter(n=>n.group==='source').map(n=>n.id),body.id);s.title='What needs my attention?';s.model='Claude';s.revision++;sessions.push(s);return json(s);}
    const s=sessions.find(s=>s.id===body.id);if(!s)return json({error:'No demo session'},404);
    if(action==='/draft'){s.draft=body.text;s.revision++;return json(s);}
    if(action==='/send'){
      if(!/^what needs my attention\??$/i.test(body.text.trim()))return json({error:'This fixture answers “What needs my attention?”'},409);
      // Keep the optimistic message as the sole visible copy during the delay.
      await new Promise(r=>setTimeout(r,1800));
      const at=new Date().toISOString();s.messages.push({id:crypto.randomUUID(),role:'user',text:body.text,at});
      s.context=priorities.map(p=>p.id);s.viewRevision++;
      s.messages.push({id:crypto.randomUUID(),role:'assistant',at,text:'## 36 unread. Three need you.\n\nAcross your three inboxes and three Slack channels:\n\n1. **Approve the launch date by 2pm.** [Alex · work email](#/vault/memory%2Finbox-0-0.md)\n2. **Unblock Maya’s onboarding work.** [Maya · Slack #product](#/vault/memory%2Finbox-3-0.md)\n3. **Review the interview plan before tomorrow.** [Research inbox](#/vault/memory%2Finbox-2-0.md)\n\nThe other 33 can wait.'});
      s.draft='';s.phase='answered';s.revision++;s.updated=at;return json(s);
    }
    return json({error:'Outside this demo fixture'},409);
  }) as typeof window.fetch;
  document.documentElement.dataset.theme=new URLSearchParams(location.search).get('theme')==='default'?'default':'web';document.documentElement.dataset.typeStudy='proposed';document.documentElement.dataset.studyDock='side';
  location.hash='/';mount(Base,{target:document.getElementById('app')!,props:{view:'classic'}});
  let opened=false;
  new MutationObserver(()=>{if(!document.querySelector('.pilot-panel')){opened=false;return;}if(!opened){opened=true;if(new URLSearchParams(location.search).has('assembly'))return;document.querySelector<HTMLButtonElement>('button[aria-label="Expand text tab"]')?.click();}}).observe(document.body,{childList:true,subtree:true});
}
