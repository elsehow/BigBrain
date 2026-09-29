import { test, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { PilotChats, pilotChatTools, pilotInstructions } from './support/pilotSession';
import { WorkHistory } from '../lib/workHistory';
import { nativeVault } from './support/vault';

test('Pilot retains knowledge tools without agent execution', () => {
  const names = pilotChatTools().map(t => t.name);
  for (const name of ['read_file', 'write_scratch', 'list_files', 'notify_user']) expect(names).toContain(name);
  for (const name of ['run_command','request_access','request_browser','browser','start_preview','request_github','start_work', 'send_work', 'answer_work', 'link_work', 'list_work', 'read_work', 'stop_work']) expect(names).not.toContain(name);
  for (const name of ['launch_agent', 'message_agent', 'reply_agent', 'read_agent', 'list_agent_models', 'inspect_agent_environment', 'revise_agent_environment']) expect(names).not.toContain(name);
  expect(pilotInstructions()).toContain('You cannot launch agents');
  expect(pilotInstructions()).not.toContain('Delegate when');
});

test('stale execution tools are rejected by the simplified Pilot', async () => {
  const root = nativeVault({ files: { '.env': 'OPENAI_API_KEY=sk-test\nBIGBRAIN_PILOT_ENABLED=true\n' } });
  let rounds = 0;
  const retired = ['launch_agent', 'message_agent', 'reply_agent', 'inspect_agent_environment', 'revise_agent_environment', 'run_command', 'start_work'];
  const toolErrors:string[]=[];
  const work = new WorkHistory(root);
  const chats = new PilotChats(root, { work, graph: () => [],
    fetch: (async (_url, init) => {
      for (const item of JSON.parse(String(init?.body)).input ?? []) if(item.type==='function_call_output') {
        if (item.output.includes("not found")) toolErrors.push(item.output);
      }
      const name = retired[rounds++];
      const output = name
        ? [{type:'function_call',call_id:`stale-${rounds}`,name,arguments:JSON.stringify({text:'Execute',command:'echo done'})}]
        : [{type:'message',role:'assistant',content:[{type:'output_text',text:'Please use your own external agent.'}]}];
      return new Response('event: response.completed\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',output}})+'\n\n',{headers:{'content-type':'text/event-stream'}});
    }) as typeof fetch });
  try {
    const s = chats.create([]); chats.send(s.id, 'Do this directly'); await chats.settled(s.id);
    for (const name of retired) expect(toolErrors.some(error => error.includes(name))).toBe(true);
    expect(s.messages.at(-1)?.text).toBe('Please use your own external agent.');
  } finally { chats.close(); rmSync(root, { recursive:true, force:true }); }
});
