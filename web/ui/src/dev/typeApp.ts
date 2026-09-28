import { publicPilotFixture } from "./publicPilotFixture";
// Full production App with fabricated data. Only loaded by the dev-only HTML entry.
import { mount } from 'svelte';
import AppShell from '../components/AppShell.svelte';
import { app } from '../lib/store.svelte';
import { chat } from '../lib/pilotChat.svelte';
import { newPilotChatSession } from '../../../../lib/pilotChatTypes';
import { BRIEFINGS, installFakeApi, setVaultState } from './fakeApi';
import '../design/tokens.css';
import '../app.css';
import './typeStudy.css';

if (import.meta.env.DEV) {
  installFakeApi();
  // Presence beacons must stay inside this fabricated world too.
  navigator.sendBeacon = () => true;
  const fixture = BRIEFINGS.ready!;
  setVaultState(fixture);
  const session = newPilotChatSession(fixture.graph.nodes.slice(0,3).map(n => n.id));
  session.title = 'Atlas · next steps';
  session.phase = 'answered';
  session.model = 'Claude';
  const at = new Date().toISOString();
  session.messages = [
    {id:'question',role:'user',at,text:'What’s next on Atlas? Pull out the action items from the meeting.'},
    {id:'answer',role:'assistant',at,text:'## Two things need your attention\n\nThe review raised one decision and one piece of follow-up work.\n\n1. **Choose the evaluation approach.** Compare the original dataset with the revised sample before the next review.\n2. **Draft the recommendation.** Explain which approach to use and call out the remaining assumptions.\n\nThe [[memory/project.md|project notes]] connect the evaluation work to the upcoming review.'}
  ];
  chat.sessions = [publicPilotFixture(session)]; chat.graph = fixture.graph; app.pilotAutofocus = false;
  const fake = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, options?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith('/api/pilot/chat')) return fake(input, options);
    const action = url.pathname.slice('/api/pilot/chat'.length);
    const body = JSON.parse(String(options?.body ?? '{}'));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json'}});
    if (!action) return json({sessions:[session]});
    if (action === '/notifications') return json({notifications:[]});
    if (action === '/presence') return json({ok:true});
    if (action === '/draft') {session.draft = body.text; session.revision++; return json(session);}
    return json({error:'Typography preview only. No agent runs or settings changes are made.'},409);
  }) as typeof window.fetch;
  document.documentElement.dataset.theme = 'default';
  document.documentElement.dataset.typeStudy = 'proposed';
  location.hash = `/session/${session.id}`;
  // Parent controls switch between these real routes, without rebuilding the App.
  document.documentElement.dataset.pilotRoute = `/session/${session.id}`;
  mount(AppShell,{target:document.getElementById('app')!});
}
