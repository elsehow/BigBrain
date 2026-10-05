import { publicPilotFixture } from "./publicPilotFixture";
// Scripted recording fixture. Production components, fictional Granola content.
import { mount } from 'svelte';
import Base from '../components/Base.svelte';
import { app } from '../lib/store.svelte';
import { chat } from '../lib/pilotChat.svelte';
import { refreshWork } from '../lib/workSessions.svelte';
import { newPilotChatSession, type PilotChatSession } from '../../../../lib/pilotChatTypes';
import { BRIEFINGS, installFakeApi, setVaultState } from './fakeApi';
import '../design/tokens.css';
import '../app.css';
import './typeStudy.css';
import { installLeftSidebar } from './leftSidebar';
import { agentChatFixture } from './agentChatScenes';
import './textSidebar.css';

if (import.meta.env.DEV) {
  installFakeApi();
  navigator.sendBeacon = () => true;
  const meeting = 'memory/weekly-sync.md';
  const project = 'memory/launch.md';
  const title = 'Weekly sync with Alex';
  const executeDemo = location.pathname.endsWith('/meeting-action-demo.html');
  const textSidebar = location.pathname.endsWith('/text-sidebar.html');
  const worker = agentChatFixture('running');
  worker.title = 'Compare onboarding approaches'; worker.status = 'idle'; delete worker.origin;
  worker.context = {nodes:[meeting,project],title};
  worker.messages = [
    {id:'task',role:'user',at:worker.created,text:'Compare the three onboarding approaches from the meeting.'},
    {id:'answer',role:'agent',at:worker.updated,text:'## Start with a guided first task\n\n1. **Guided setup** helps someone get a useful result from their own material.\n2. **An example vault** is quick to explore, but less personal.\n3. **A walkthrough** is helpful, but requires scheduling.\n\nI’d recommend guided setup for the first version.'}
  ];
  const demoFixture = {...BRIEFINGS.ready!, label:'Meeting demo', recent:[], workSessions:textSidebar?[worker]:[],
    graph:{hash:'meeting-demo',nodes:[
      {id:meeting,path:meeting,title,group:'source',from:'granola',degree:1,x:0,y:0},
      {id:project,path:project,title:'Launch plan',group:'memory',degree:1,x:150,y:70}
    ],edges:[{source:meeting,target:project}]},
    notes:{
      [meeting]:{path:meeting,content:`# ${title}\n\nGranola · September 18 · 25 minutes\n\n## Transcript\n\nAlex: Before Friday, compare the three onboarding approaches and recommend one.\n\nSam: I’ll put the comparison in the launch plan.\n\nAlex: Great. Send me the recommendation by Thursday afternoon so I can review it. And schedule two customer interviews for next week.\n\nSam: Got it — comparison, recommendation Thursday, and two interviews.`,sourceAssertions:[]},
      [project]:{path:project,content:'# Launch plan\n\nChoose an onboarding approach before Friday’s review.'}
    },
    noteSummary:()=>'Granola · Weekly 1:1 with Alex. You agreed to compare onboarding approaches, send a recommendation by Thursday, and arrange two customer interviews.'
  };
  if(executeDemo) {
    demoFixture.notes[meeting].content = '# Weekly sync with Alex\n\nGranola · September 18 · 25 minutes\n\nAlex: Before Friday, compare guided setup, an example vault, and a personal walkthrough. Draft your recommendation, and prepare five questions for our customer interviews.\n\nSam: Got it. I’ll put all three drafts in the launch plan.';
    demoFixture.noteSummary = () => 'Granola · Weekly 1:1 with Alex. Compare three onboarding approaches, draft a recommendation, and prepare five customer interview questions before Friday.';
  }
  if(executeDemo) {
    const outputs = [
      ['onboarding-comparison','Onboarding comparison','## Three approaches\n\n**Guided setup** — useful results from your own material. Requires a carefully designed first task.\n\n**Example vault** — instant exploration. Less personal, so value may not transfer.\n\n**Personal walkthrough** — tailored help. Requires scheduling and staff time.'],
      ['recommendation','Recommendation','## Start with a guided first task\n\nLet someone ask a useful question about one meeting before asking them to configure their entire workspace. Offer the example vault as a fallback.'],
      ['interview-questions','Interview questions','## Five questions\n\n1. What did you last need to find after a meeting?\n2. Where did you look first?\n3. What stopped you from acting on it?\n4. What would you trust an agent to draft?\n5. What would you always want to review?']
    ];
    for(const [slug,label,body] of outputs) {
      const path=`memory/${slug}.md`;
      Object.assign(demoFixture.notes,{[path]:{path,content:`# ${label}\n\n${body}`}});
      demoFixture.graph.nodes.push({id:path,path,title:label,group:'memory',degree:1,x:100,y:100});
      demoFixture.graph.edges.push({source:project,target:path});
    }
    demoFixture.noteSummary = (selected?: string[]) => {
      const output=outputs.find(([slug])=>selected?.includes(`memory/${slug}.md`));
      return output ? output[2].replace(/^## .+\n\n/,'') : 'Granola · Weekly 1:1 with Alex. Compare three onboarding approaches, draft a recommendation, and prepare five customer interview questions before Friday.';
    };
  }
  // Deterministic sample vault: a populated overview before the camera
  // focuses on the meeting. No personal vault data enters the recording.
  if(executeDemo) {
    const topics=['Product research','Design notes','Reading list','Customer interviews','Launch planning','Engineering','Team meetings','Ideas'];
    for(let cluster=0;cluster<topics.length;cluster++) {
      const angle=cluster*Math.PI*2/topics.length;
      const cx=Math.cos(angle)*370,cy=Math.sin(angle)*240;
      const hub=`memory/demo-topic-${cluster}.md`;
      demoFixture.graph.nodes.push({id:hub,path:hub,title:topics[cluster],group:'memory',degree:28,x:cx,y:cy});
      demoFixture.graph.edges.push({source:hub,target:`memory/demo-topic-${(cluster+1)%topics.length}.md`});
      for(let n=0;n<26;n++) {
        const a=n*2.39996323+cluster*.7,r=25+Math.sqrt(n/26)*110;
        const id=`memory/demo-source-${cluster}-${n}.md`;
        demoFixture.graph.nodes.push({id,path:id,title:`${topics[cluster]} · ${['Notes','Conversation','Paper','Follow-up','Reference'][n%5]} ${n+1}`,group:n%6===0?'memory':'source',degree:1,x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r*.8});
        demoFixture.graph.edges.push({source:hub,target:id});
        if(n%7===0)demoFixture.graph.edges.push({source:id,target:`memory/demo-topic-${(cluster+1)%topics.length}.md`});
      }
    }
    for(const target of ['memory/demo-topic-0.md','memory/demo-topic-4.md','memory/demo-topic-6.md'])demoFixture.graph.edges.push({source:meeting,target});
    const degrees=new Map<string,number>();
    for(const edge of demoFixture.graph.edges)for(const id of [edge.source,edge.target])degrees.set(id,(degrees.get(id)??0)+1);
    for(const node of demoFixture.graph.nodes)node.degree=degrees.get(node.id)??0;
    demoFixture.graph.hash='meeting-populated-overview';
  }
  if(executeDemo){
    for(const [id,label,group,x,y] of [['memory/alex.md','Alex','entity',-100,-70],['memory/interviews.md','Customer interviews','memory',180,-100]] as const){
      demoFixture.graph.nodes.push({id,path:id,title:label,group,degree:1,x,y});
      demoFixture.graph.edges.push({source:meeting,target:id});
      Object.assign(demoFixture.notes,{[id]:{path:id,content:`# ${label}`}});
    }
  }
  setVaultState(demoFixture);
  chat.sessions=[]; app.pilotAutofocus=true;
  const sessions: PilotChatSession[]=[];
  const previewPilot = newPilotChatSession([meeting]);
  if(textSidebar) {
    previewPilot.title=title;previewPilot.model='Claude';previewPilot.phase='answered';
    previewPilot.messages=[{id:'question',role:'user',at:previewPilot.created,text:'What are the action items?'},{id:'answer',role:'assistant',at:previewPilot.created,text:`## Your three action items\n\n1. **Compare the onboarding approaches** before Friday.\n2. **Send Alex your recommendation** by Thursday afternoon.\n3. **Schedule two customer interviews** for next week.\n\nFrom [[${meeting}|${title}]].`}];
    sessions.push(previewPilot);chat.sessions = [publicPilotFixture(previewPilot)];
  }
  const fake=window.fetch;
  window.fetch=(async(input:RequestInfo|URL,options?:RequestInit)=>{
    const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url,location.href);
    if(url.pathname.startsWith('/api/search')) return new Response(JSON.stringify({query:url.searchParams.get('q'),hits:/weekly|sync|alex|meeting|granola/i.test(url.searchParams.get('q')??'')?[{dir:'memory',title,note:{path:meeting,title,kind:'source',modified:Date.parse('2026-09-18T16:00:00Z')},snippet:'Granola · Weekly 1:1 · onboarding, recommendation, customer interviews'}]:[],nextOffset:null}),{headers:{'content-type':'application/json'}});
    if(!url.pathname.startsWith('/api/pilot/chat')) return fake(input,options);
    const action=url.pathname.slice('/api/pilot/chat'.length);
    const body=JSON.parse(String(options?.body??'{}'));
    const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
    if(!action)return json({sessions});
    if(action==='/notifications')return json({notifications:[]});
    if(action==='/presence')return json({ok:true});
    if(action==='/create'){
      const s=newPilotChatSession(body.context,body.id);s.title=title;s.model='Claude';sessions.push(s);return json(s);
    }
    const s=sessions.find(s=>s.id===body.id);
    if(!s)return json({error:'No demo session'},404);
    if(action==='/draft'){s.draft=body.text;s.revision++;return json(s);}
    if(action==='/send'){
      const doThem = executeDemo && /^(do them|do it|go ahead)[.!]?$/i.test(body.text.trim());
      if(!doThem && !/what are (the|my) action items\??/i.test(body.text.trim()))return json({error:'This scripted demo answers “What are the action items?” only.'},409);
      const at=new Date().toISOString();
      // Until this mock request completes, Pilot already displays its
      // optimistic queued message. Do not publish the same message through
      // polling during the artificial delay: that paints it twice.
      await new Promise(r=>setTimeout(r,850));
      s.draft='';
      let answer = `## Your three action items\n\n1. **Compare the three onboarding approaches** before Friday’s review.\n2. **Send Alex your recommendation** by Thursday afternoon.\n3. **Schedule two customer interviews** for next week.\n\nFrom [[${meeting}|${title}]].`;
      if(executeDemo) answer = `## Three things before Friday\n\n1. **Compare** the three onboarding approaches.\n2. **Draft** your recommendation.\n3. **Prepare** five customer interview questions.\n\nFrom [[${meeting}|${title}]].`;
      if(executeDemo) {s.context=[meeting,'memory/alex.md',project,'memory/interviews.md'];s.viewRevision++;}
      if(doThem) {
        answer='Started an agent to compare the approaches, draft your recommendation, and prepare the interview questions.';
        worker.title='Prepare the meeting follow-ups';worker.status='working';
        worker.origin={pilot:s.id,message:'demo-followups'};
        worker.context={nodes:[...s.context],title};
        worker.messages=[{id:'task',role:'user',at,text:'Compare onboarding approaches, draft a recommendation, and prepare five interview questions.'},{id:'progress',role:'agent',at,text:'Reading the meeting and launch plan. Starting the comparison.'}];
        demoFixture.workSessions.push(worker);
        await refreshWork();
      }
      s.messages.push({id:crypto.randomUUID(),role:'user',text:body.text,at});
      s.messages.push({id:crypto.randomUUID(),role:'assistant',at,text:answer});
      s.phase='answered';s.revision++;s.updated=new Date().toISOString();return json(s);
    }
    return json({error:'This action is not part of the scripted demo.'},409);
  }) as typeof window.fetch;
  document.documentElement.dataset.theme='default';
  document.documentElement.dataset.typeStudy='proposed';
  document.documentElement.dataset.studyDock='side';
  const leftSidebar = location.pathname.endsWith('/left-sidebar.html');
  if(leftSidebar) document.documentElement.dataset.studyDock='bottom';
  if(textSidebar) {document.documentElement.dataset.textSidebar='true';document.documentElement.dataset.studyDock='bottom';}
  location.hash=textSidebar ? `/vault/${meeting}` : '/';
  mount(Base,{target:document.getElementById('app')!,props:{view:'classic',shell:{baseline:leftSidebar || textSidebar}}});
  if(leftSidebar) installLeftSidebar();
  if(textSidebar) {
    const controls=document.createElement('nav');controls.className='study-text-switcher';controls.setAttribute('aria-label','Preview scenes');
    controls.append('Preview: ');
    for(const [label,route] of [['Note',`/vault/${meeting}`],['Pilot',`/session/${previewPilot.id}`],['Agent',`/vault/sessions/${worker.id}.md`]]) {
      const button=document.createElement('button');button.textContent=label;button.onclick=()=>location.hash=route;controls.append(button);
    }
    document.body.append(controls);
  }
  // Open the existing expanded view once each new Pilot is mounted.
  let opened=false;
  new MutationObserver(()=>{
    const panel=document.querySelector('.pilot-panel');
    if(!panel){opened=false;return;}
    if(!opened){opened=true;document.querySelector<HTMLButtonElement>('button[aria-label="Expand text tab"]')?.click();}
  }).observe(document.body,{childList:true,subtree:true});
}
