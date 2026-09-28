import { publicPilotFixture } from "./publicPilotFixture";
// Fictional Atlas specimen: production UI with deterministic sample context.
import {mount} from 'svelte';
import AppShell from '../components/AppShell.svelte';
import {app} from '../lib/store.svelte';
import {chat} from '../lib/pilotChat.svelte';
import {refreshWork} from '../lib/workSessions.svelte';
import {newPilotChatSession} from '../../../../lib/pilotChatTypes';
import {agentChatFixture} from './agentChatScenes';
import {BRIEFINGS,installFakeApi,setVaultState,type VaultState} from './fakeApi';
import '../design/tokens.css';import '../app.css';import './typeStudy.css';import './contextDemo.css';
if(import.meta.env.DEV){
  installFakeApi();navigator.sendBeacon=()=>true;
  const titles=['Atlas project','Weekly sync · Alex','Launch checklist','Customer interviews','API codebase','Design review','Pilot feedback','Release plan','Research notes','Slack · engineering','Open issues','Product roadmap','Alex'];
  const ids=titles.map((_,i)=>`memory/atlas-${i}.md`);
  const pilot=newPilotChatSession([ids[0]]);pilot.title='Atlas';pilot.phase='answered';pilot.revision++;
  const worker=agentChatFixture('running');worker.id=`work-${'3'.repeat(32)}`;
  worker.provider='claude-code';worker.model='Opus';worker.status='idle';worker.title='Atlas · Next steps';
  worker.context={nodes:[ids[0]],title:'Atlas project'};worker.origin={pilot:pilot.id,message:'atlas'};
  worker.messages=[{id:'question',role:'user',at:worker.created,text:'What’s next on the Atlas project?'}];
  const fixture:VaultState={...BRIEFINGS.ready!,recent:[],workSessions:[worker],
    graph:{hash:'atlas-context',nodes:ids.map((id,i)=>({id,path:id,title:titles[i],group:i===0?'memory':'source',degree:2,x:i===0?0:Math.cos((i-1)/12*Math.PI*2)*330,y:i===0?0:Math.sin((i-1)/12*Math.PI*2)*260})),edges:ids.slice(1).map(id=>({source:ids[0],target:id}))},
    notes:Object.fromEntries(ids.map((id,i)=>[id,{path:id,content:`# ${titles[i]}\n\nAtlas project context.`,sourceAssertions:[]}]))
  };
  setVaultState(fixture);chat.sessions = [publicPilotFixture(pilot)];chat.graph=fixture.graph;app.pilotAutofocus=false;
  const fake=window.fetch;
  window.fetch=(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    if(!url.pathname.startsWith('/api/pilot/chat'))return fake(input,options);
    return new Response(JSON.stringify({sessions:[pilot],notifications:[],ok:true}),{headers:{'content-type':'application/json'}});
  }) as typeof window.fetch;
  document.documentElement.dataset.contextRecording='true';document.documentElement.dataset.theme='phosphor';document.documentElement.dataset.typeStudy='proposed';document.documentElement.dataset.studyDock='side';
  location.hash=`/vault/sessions/${worker.id}.md`;mount(AppShell,{target:document.getElementById('app')!});
  window.addEventListener('bb:context-cue',(event)=>{
    const {count,answer}= (event as CustomEvent<{count:number;answer:boolean}>).detail;
    worker.context={nodes:ids.slice(0,count),title:'Atlas project'};
    pilot.context=ids.slice(0,count);pilot.revision++;chat.sessions=[publicPilotFixture(pilot)];
    worker.status=answer?'idle':'working';
    if(answer)worker.messages=[worker.messages[0],{id:'answer',role:'agent',at:new Date().toISOString(),text:'## Three next steps for Atlas\n\n1. **Unblock the API release.** Fix the auth issue Maya flagged.\n2. **Test with five customers.** Use the interview plan from your last sync.\n3. **Ship the pilot Friday.** Alex confirmed the date.\n\nSources: [Engineering](#/vault/memory%2Fatlas-9.md) · [Customer interviews](#/vault/memory%2Fatlas-3.md) · [Weekly sync](#/vault/memory%2Fatlas-1.md)'}];
    worker.updated=new Date().toISOString();void refreshWork();
  });
}
