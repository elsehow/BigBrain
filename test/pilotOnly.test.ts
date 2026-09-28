import { test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { PilotChats, pilotChatTools, pilotInstructions } from './support/pilotSession';
import { WorkHistory } from '../lib/workHistory';
import { nativeVault } from './support/vault';

test('Pilot tools expose agent sessions and omit retired worker mutations', () => {
  const names = pilotChatTools().map(t => t.name);
  for (const name of ['read_file', 'write_scratch', 'list_files', 'notify_user']) expect(names).toContain(name);
  for (const name of ['run_command','request_access','request_browser','browser','start_preview','request_github','start_work', 'send_work', 'answer_work', 'link_work', 'list_work', 'read_work', 'stop_work']) expect(names).not.toContain(name);
  expect(names).toContain('launch_agent');
  expect(pilotInstructions()).toContain('launch_agent');
  expect(pilotInstructions()).not.toContain('Delegate when');
});

test('stale execution tools are rejected by the simplified Pilot', async () => {
  const root = nativeVault({ files: { '.env': 'OPENAI_API_KEY=sk-test\nBIGBRAIN_PILOT_ENABLED=true\n' } });
  let starts = 0, rounds = 0;
  const toolErrors:string[]=[];
  const work = new WorkHistory(root);
  work.start = async () => { starts++; throw new Error('Must not execute'); };
  const chats = new PilotChats(root, { work, graph: () => [],
    fetch: (async (_url, init) => {
      for (const item of JSON.parse(String(init?.body)).input ?? []) if(item.type==='function_call_output') {
        if (item.output.includes("not found")) toolErrors.push(item.output);
      }
      const output = rounds++ === 0
        ? [{type:'function_call',call_id:'stale',name:'start_work',arguments:JSON.stringify({text:'Delegate',scratch:true})}]
        : rounds === 2 ? [{type:'function_call',call_id:'direct',name:'run_command',arguments:JSON.stringify({command:'echo done',timeout_ms:300000})}]
        : [{type:'message',role:'assistant',content:[{type:'output_text',text:'Please use a agent session.'}]}];
      return new Response('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',output}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
    }) as typeof fetch });
  try {
    const s = chats.create([]); chats.send(s.id, 'Do this directly'); await chats.settled(s.id);
    expect(starts).toBe(0);
    expect(toolErrors.length).toBeGreaterThanOrEqual(2);
    expect(s.messages.at(-1)?.text).toBe('Please use a agent session.');
  } finally { chats.close(); rmSync(root, { recursive:true, force:true }); }
});
