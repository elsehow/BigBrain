import { afterAll, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spoolDir } from "../lib/spool";
import { PilotChats } from "./support/pilotSession";
import { PILOT_TEXT_MODEL, pilotContextLabel } from "../lib/pilotChatTypes";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
const vault = () => { const root = nativeVault({ files: { ".env": "OPENAI_API_KEY=sk-test-not-a-real-api-key\nBIGBRAIN_PILOT_ENABLED=true\n" } }); roots.push(root); return root; };
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })));
const nodes = [ {id:"dana", path:"entities/dana.md", title:"Dana", degree:1, group:"entity", x:0, y:0}, {id:"arbor", path:"entities/arbor.md", title:"Arbor", degree:1, group:"entity", x:40,y:30} ];
test("mention context additions are additive, canonical, idempotent and durable", () => {
  const root = vault(), sessions = new PilotChats(root, { graph: () => nodes, fetch });
  const s = sessions.create(["dana"]), other = sessions.create([]);
  sessions.addContext(s.id, ["entities/arbor.md"]);
  expect(s.context).toEqual(["dana", "arbor"]);
  const revision = s.viewRevision;
  sessions.addContext(s.id, ["arbor", s.id]); expect(s.viewRevision).toBe(revision);
  expect(() => sessions.setContext(s.id, [], "Stale", revision - 1)).toThrow("context changed");
  sessions.addContext(s.id, [other.id]);
  expect(() => sessions.addContext(s.id, ["../../private"])).toThrow();
  sessions.close();
  const resumed = new PilotChats(root, { graph: () => nodes, fetch });
  expect(resumed.get(s.id).context).toEqual(["dana", "arbor", other.id]);
  resumed.close();
});
test("valid mentions outside the base graph are kept as context", () => {
  const root = nativeVault({ files: { "memory/extra.md": "# Extra context\nA useful note." } }); roots.push(root);
  const sessions = new PilotChats(root, { graph: () => [], fetch });
  const s = sessions.create([]); sessions.addContext(s.id, ["memory/extra.md"]);
  expect(s.context).toEqual(["memory/extra.md"]);
  sessions.setContext(s.id, ["memory/extra.md"], "Context", s.viewRevision);
  sessions.close();
});
test("Pi Pilot finishes beyond the former round and tool ceilings", async () => {
  let rounds = 0, calls = 0;
  const sessions = new PilotChats(vault(), {
    graph: () => nodes,
    tool: async () => { calls++; return { found: "next source" }; },
    fetch: (async () => stream([done(rounds++ < 40
      ? [call("search_vault", { query: `source ${rounds}` })]
      : [text("Finished all sources")])])) as typeof fetch,
  });
  try {
    const s = sessions.create([]);
    sessions.send(s.id, "Read every source"); await sessions.settled(s.id);
    expect(calls).toBe(40);
    expect(s.phase).toBe("answered");
    expect(s.messages.at(-1)?.text).toBe("Finished all sources");
  } finally { sessions.close(); }
});
const done = (output: unknown[]) => ({ type: "response.completed", response: {status:"completed",output} });
const text = (value: string) => ({type:"message",role:"assistant",content:[{type:"output_text",text:value}]});
const call = (name: string, args: unknown) => ({type:"function_call",call_id:crypto.randomUUID(),name,arguments:JSON.stringify(args)});
function stream(events: unknown[]): Response {
 const encoded = new TextEncoder().encode(events.map(e=>`event: response\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join(""));
 return new Response(new ReadableStream({start(c){for(let i=0;i<encoded.length;i+=7)c.enqueue(encoded.slice(i,i+7));c.close();}}),{headers:{"content-type":"text/event-stream"}});
}

test("image-only Pilot turns survive retries and reload and reach Pi as images", async () => {
  const root = vault(), requests: any[] = [];
  const sessions = new PilotChats(root, { graph: () => [], fetch: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body))); return stream([done([text("An image.")])]);
  }) as typeof fetch });
  const image = sessions.uploadImage("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNo+A8AAgIBgG5WixMAAAAASUVORK5CYII=", "Screenshot.png"), s = sessions.create([]);
  sessions.draft(s.id, "", [image]);
  expect(() => sessions.discard(s.id)).toThrow("empty draft");
  const input = { id: "image-input-001", mode: "text" as const, images: [image] };
  sessions.submit(s.id, "", input); await sessions.settled(s.id);
  sessions.submit(s.id, "", input);
  expect(s.messages).toHaveLength(2);
  expect(s.messages[0]!.images).toEqual([image]);
  expect(s.draftImages).toEqual([]);
  expect(requests[0].input[0].content[1].type).toBe("image");
  expect(requests[0].input[0].content[1].mimeType).toBe("image/png");
  expect(requests[0].input[0].content[1].data).toStartWith("iVBOR");
  expect(() => sessions.submit(s.id, "", { ...input, images: [image, image] })).toThrow("different message");
  sessions.send(s.id, "What color?"); await sessions.settled(s.id);
  expect(requests[1].input[0].content[1].data).toBe(requests[0].input[0].content[1].data);
  sessions.close();
  const reopened = new PilotChats(root, { graph: () => [], fetch });
  expect(reopened.get(s.id).messages[0]!.images).toEqual([image]); reopened.close();
});

describe("text Pilot sessions", () => {
 test("answers without tools get durable titles and legacy placeholders are repaired", async () => {
  const root = vault();
  const sessions = new PilotChats(root, { graph: () => [], fetch: (async () => stream([done([text("Still waiting.")])])) as typeof fetch });
  const s = sessions.create([]);
  sessions.draft(s.id, "Any news?");
  sessions.send(s.id, "Waiting on [[memory/career|Epoch]]\n  after the work test");
  await sessions.settled(s.id);
  expect(s.title).toBe("Waiting on Epoch after the work test");
  expect(s.context).toEqual([]);
  sessions.send(s.id, "What about Monday?"); await sessions.settled(s.id);
  expect(s.title).toBe("Waiting on Epoch after the work test");
  const named = sessions.create([]);
  sessions.setContext(named.id, [], "Chosen title", named.viewRevision);
  sessions.draft(named.id, "A draft must not overwrite this title");
  expect(named.title).toBe("Chosen title");
  sessions.close();
  // Simulate a saved conversation created before automatic naming.
  writeFileSync(join(spoolDir(root), "pilot-chats", `${s.id}.json`), JSON.stringify({ ...s, title: "Draft session" }));
  const reopened = new PilotChats(root, { graph: () => [], fetch });
  expect(reopened.get(s.id).title).toBe("Waiting on Epoch after the work test");
  expect(reopened.get(named.id).title).toBe("Chosen title");
  reopened.close();
 });
 test("Quick names engine-titled tasks as they develop and never over a person's name", async () => {
  const root = vault();
  const asked: string[] = [];
  const nameTask = async (_: string, messages: readonly { role: string }[], current?: string) => { asked.push(current ?? ""); return `Task at ${messages.filter(m => m.role === "user").length}`; };
  const sessions = new PilotChats(root, { graph: () => [], nameTask, fetch: (async () => stream([done([text("Noted.")])])) as typeof fetch });
  const turn = async (id: string, text: string) => { sessions.send(id, text); await sessions.settled(id); await Bun.sleep(0); };
  const s = sessions.create([]);
  await turn(s.id, "how long should sourdough proof overnight");
  expect(s.title).toBe("Task at 1"); expect(s.titleSource).toBe("auto");
  await turn(s.id, "and last year?"); expect(s.title).toBe("Task at 2");
  await turn(s.id, "thanks"); expect(s.title).toBe("Task at 2"); // 3 is not a naming moment
  await turn(s.id, "one more"); expect(s.title).toBe("Task at 4");
  sessions.rename(s.id, "Sourdough timing");
  await turn(s.id, "five"); await turn(s.id, "six"); await turn(s.id, "seven"); await turn(s.id, "eight");
  expect(s.title).toBe("Sourdough timing"); expect(s.titleSource).toBe("human");
  // a title from before titleSource: a "Re: …" seed is the engine's, a chosen one is not
  const seeded = sessions.create([]); sessions.setContext(seeded.id, [], "Re: Arbor", seeded.viewRevision);
  const chosen = sessions.create([]); sessions.setContext(chosen.id, [], "Chosen title", chosen.viewRevision);
  await turn(seeded.id, "what is Arbor?"); await turn(chosen.id, "what is Arbor?");
  expect(seeded.title).toBe("Task at 1"); expect(chosen.title).toBe("Chosen title");
  sessions.close();
 });
 test("canonical seed, replacement, stale revisions, and durable draft", () => {
  const root=vault(), sessions=new PilotChats(root,{graph:()=>nodes,fetch:fetch});
  const s=sessions.create(["entities/dana.md","dana"]);expect(s.seed).toEqual(["dana"]);
  sessions.draft(s.id,"First line\nSecond line");expect(()=>sessions.discard(s.id)).toThrow("empty draft");
  sessions.setContext(s.id,["arbor"],"Arbor",0);expect(s.context).toEqual(["arbor"]);expect(s.seed).toEqual(["dana"]);
  expect(()=>sessions.setContext(s.id,["dana"],"Stale",0)).toThrow("changed");
  expect(()=>sessions.setContext(s.id,["invented"],"Bad",1)).toThrow("Unknown");expect(s.context).toEqual(["arbor"]);
  const reopened=new PilotChats(root,{graph:()=>nodes,fetch:fetch}).get(s.id);expect(reopened.draft).toBe("First line\nSecond line");expect(reopened.context).toEqual(["arbor"]);
  sessions.draft(s.id,"");sessions.discard(s.id);expect(sessions.list()).toHaveLength(0);
 });
 test("stream, tool execution, context updates, repeated turns, and model contract", async () => {
  const requests: any[]=[];const called: string[]=[];
  const outputs=[ [call("search_vault",{query:"Arbor"})], [call("set_context",{nodes:["arbor"],title:"Arbor research",expected_revision:0})], [call("read_note",{path:"entities/arbor.md"})], [text("Arbor café [[entities/arbor.md|source]]")], [text("A follow-up")] ];
  const sessions=new PilotChats(vault(),{graph:()=>nodes,tool:async name=>{called.push(name);return {found:"arbor"};},fetch:(async (_url,init)=>{
   requests.push(JSON.parse(String(init?.body)));return stream([{type:"response.output_text.delta",delta:"Thinking…"},done(outputs.shift()!)]);
  }) as typeof fetch});
  const s=sessions.create(["dana"]);sessions.send(s.id,"Find Arbor");expect(()=>sessions.send(s.id,"duplicate")).toThrow("already working");await sessions.settled(s.id);
  expect(s.phase).toBe("answered");expect(s.context).toEqual(["arbor"]);expect(s.title).toBe("Arbor research");expect(called).toEqual(["search_vault","read_note"]);
  expect(s.messages[1].text).toContain("café");expect(s.live).toBe("");
  expect(requests[0].model).toBe(PILOT_TEXT_MODEL);
  expect(requests[1].input.some((i:any)=>i.type==="function_call_output")).toBe(true);
  sessions.send(s.id,"What next?");await sessions.settled(s.id);expect(s.messages).toHaveLength(4);expect(requests.at(-1).instructions).toContain('"revision":1');
  expect(requests.at(-1).input.some((i:any)=>JSON.stringify(i).includes("café"))).toBe(true);
 });
 test("mentions identify exact notes and let read_note open another Pilot's durable conversation", async () => {
  const requests: any[] = [];
  let referenced = "";
  const sessions = new PilotChats(vault(), { graph: () => [], fetch: (async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return stream([done(requests.length === 1 ? [call("read_note", { path: referenced })] : [text("Based on that conversation.")])]);
  }) as typeof fetch });
  const other = sessions.create([]); referenced = other.id;
  other.messages.push({ id: "m", role: "user", text: "The exact prior evidence", at: other.created });
  sessions.draft(other.id, "Private unfinished draft");
  const s = sessions.create([]);
  sessions.send(s.id, `Compare [[${other.id}|Prior session]] with [[memory/a%5Bb%5D|A note]].`);
  await sessions.settled(s.id);
  expect(s.phase).toBe("answered");
  expect(requests[0].instructions).toContain('"path":"memory/a[b]"');
  expect(requests[0].instructions).toContain(`"path":"${other.id}"`);
  const result = requests[1].input.find((r: any) => r.type === "function_call_output").output;
  expect(result).toContain("The exact prior evidence");
  expect(result).not.toContain("Private unfinished draft");
  sessions.close();
 });
 test("interrupt prevents late tool output from changing context or completing", async () => {
  let release!:()=>void;const pending=new Promise<void>(r=>release=r);let started!:()=>void;const entered=new Promise<void>(r=>started=r);
  const sessions=new PilotChats(vault(),{graph:()=>nodes,tool:async()=>{started();await pending;return {};},fetch:(async()=>stream([done([call("read_note",{path:"entities/dana.md"})])])) as typeof fetch});
  const s=sessions.create(["dana"]);sessions.send(s.id,"Read");await entered;sessions.stop(s.id);release();await sessions.settled(s.id);
  expect(s.phase).toBe("interrupted");expect(s.messages).toHaveLength(1);expect(s.context).toEqual(["dana"]);
 });
 test("does not leak upstream error bodies", async () => {
  let hits=0;const sessions=new PilotChats(vault(),{graph:()=>nodes,tool:async()=>{hits++;return {};},fetch:(async()=>new Response("secret upstream body",{status:401})) as typeof fetch});
  const s=sessions.create([]);sessions.send(s.id,"Hi");await sessions.settled(s.id);expect(s.phase).toBe("failed");expect(s.error).toContain("refused");expect(s.error).not.toContain("secret");expect(hits).toBe(0);
 });
 test("invented tools cannot reach the executor", async () => {
  let hits=0, turn=0;
  const sessions=new PilotChats(vault(),{graph:()=>nodes,tool:async()=>{hits++;return {};},fetch:(async()=>stream([done(turn++ ? [text("That tool is unavailable.")] : [call("spawn_agent",{task:"write"})])])) as typeof fetch});
  const s=sessions.create([]);sessions.send(s.id,"Try a worker");await sessions.settled(s.id);
  expect(hits).toBe(0);expect(s.phase).toBe("answered");
 });
 test("context stays exact; multi-selection labels", () => {
  const sessions=new PilotChats(vault(),{graph:()=>nodes,fetch:fetch});const s=sessions.create([]);
  expect(s.context).toEqual([]);
  sessions.setContext(s.id,["arbor"],"Arbor",0);expect(s.context).toEqual(["arbor"]);
  expect(pilotContextLabel({seed:["dana","arbor"],context:["dana","arbor"]},id=>id)).toBe("2 selected");
  expect(pilotContextLabel({seed:["dana"],context:["arbor","dana"]},id=>id)).toBe("dana + 1 selected");
  expect(pilotContextLabel({seed:["dana"],context:["arbor"]},id=>id)).toBe("1 selected");
 });
});

import { readFileSync, readdirSync } from "node:fs";
import { writeAtomic } from "../lib/fsx";
import { readConversation } from "../lib/pilotConversation";


test("Pi history retains tool evidence across turns and engine restarts", async () => {
  const root = vault(), requests: any[] = [];
  let response = 0;
  const options = { graph: () => nodes, tool: async () => ({ evidence: "Saffron-37" }), fetch: (async (_url: any, init: any) => {
    requests.push(JSON.parse(String(init.body)));
    return stream([done(response++ === 0
      ? [{ type: "reasoning", id: "rs_one", encrypted_content: "opaque-test-state", summary: [] }, call("read_note", { path: "entities/arbor.md" })]
      : [text("Saffron-37")])]);
  }) as typeof fetch };
  writeAtomic(join(root, "memory", "MEMORY.md"), "Initial memory");
  const first = new PilotChats(root, options), s = first.create([]);
  first.send(s.id, "What is the code?"); await first.settled(s.id); first.close();
  writeAtomic(join(root, "memory", "MEMORY.md"), "Updated memory");
  const resumed = new PilotChats(root, options);
  resumed.send(s.id, "Repeat it"); await resumed.settled(s.id);
  const last = requests.at(-1);
  expect(last.instructions).toContain("Updated memory");
  expect(last.input.filter((i: any) => i.type === "function_call_output")).toHaveLength(1);
  expect(JSON.stringify(last.input.at(-1))).toContain("Repeat it");
  expect(last.input.filter((i: any) => i.role === "user")).toHaveLength(2);
  const timings = readdirSync(join(spoolDir(root), "pilot-timings", s.id)).map(f => JSON.parse(readFileSync(join(spoolDir(root), "pilot-timings", s.id, f), "utf8")));
  expect(timings).toHaveLength(2);
  expect(timings.map(t => t.apiRequests.length).sort()).toEqual([1, 2]);
  expect(timings.every(t => t.totalMs >= t.setupMs && t.transport === "subscription" && t.status === "answered")).toBe(true);
  expect(JSON.stringify(timings)).not.toContain("Saffron-37");
  expect(JSON.stringify(resumed.get(s.id))).not.toContain("encrypted_content");
  resumed.close();
});
test("Pi tools execute sequentially and context mutations stay ordered", async () => {
  let active = 0, peak = 0, calls = 0, response = 0;
  const mutations = [call("set_context", { nodes: ["arbor"], title: "First", expected_revision: 1 }), call("set_context", { nodes: ["dana"], title: "Second", expected_revision: 2 })];
  const sessions = new PilotChats(vault(), { graph: () => nodes,
    tool: async () => {
      calls++; active++; peak = Math.max(peak, active);
      await new Promise(r => setTimeout(r, 10)); active--; return { read: true };
    }, fetch: (async () => stream([done(response++ ? [text("Done")] : [
      ...Array.from({ length: 7 }, () => call("read_note", { path: "entities/arbor.md" })), ...mutations,
    ])])) as typeof fetch });
  const s = sessions.create([]); sessions.send(s.id, "Read these"); await sessions.settled(s.id);
  expect(s.phase).toBe("answered"); expect(calls).toBe(7); expect(peak).toBe(1);
  expect(s.title).toBe("Second"); expect(s.context).toEqual(["dana"]); expect(s.viewRevision).toBe(3);
  sessions.setContext(s.id, ["dana"], "Second", 3); expect(s.viewRevision).toBe(3);
  sessions.close();
});
test("interrupted Pi calls never persist late tool results", async () => {
  let entered!: () => void, release!: () => void;
  const begun = new Promise<void>(r => entered = r), wait = new Promise<void>(r => release = r);
  const root = vault();
  const sessions = new PilotChats(root, { graph: () => nodes,
    tool: async () => { entered(); await wait; return "late"; },
    fetch: (async () => stream([done([call("read_note", { path: "entities/arbor.md" })])])) as typeof fetch });
  const s = sessions.create([]); sessions.send(s.id, "Read"); await begun; sessions.stop(s.id); release(); await sessions.settled(s.id);
  const saved = readConversation(root, s.id);
  expect(saved.piSession).toBeDefined();
  const history = readFileSync(saved.piSession!, "utf8");
  expect(history).not.toContain('"text":"late"');
  expect(s.phase).toBe("interrupted");
  expect(s.messages).toHaveLength(1);
  sessions.close();
});

test("an isolated Pilot does not build the vault graph to create or send", async () => {
  const sessions = new PilotChats(vault(), {
    graph: () => { throw new Error("The graph should not be needed for empty context"); },
    fetch: (async () => stream([done([text("Hello")])])) as typeof fetch,
  });
  const s = sessions.create([]); sessions.send(s.id, "Hi"); await sessions.settled(s.id);
  expect(s.phase).toBe("answered"); sessions.close();
});

test("isolated session storage resolves and reads mentions from the displayed context vault", async () => {
  const root = vault(), contextRoot = nativeVault({ files: { "memory/christina.md": "# Christina Aguila\nHiring scorer context." } }); roots.push(contextRoot);
  let response = "", rounds = 0;
  const sessions = new PilotChats(root, { contextRoot, graph: () => [], fetch: (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    for (const item of body.input) if (item.type === "function_call_output") response = item.output;
    return stream([done(rounds++ === 0 ? [call("read_note", { path: "memory/christina.md" })] : [text("Read the context.")])]);
  }) as typeof fetch });
  try {
    const s = sessions.create([]); sessions.draft(s.id, "From Christina");
    sessions.addContext(s.id, ["memory/christina.md"]);
    expect(s.context).toEqual(["memory/christina.md"]);
    expect(s.draft).toBe("From Christina");
    sessions.send(s.id, "Read [[memory/christina.md|Christina]]"); await sessions.settled(s.id);
    expect(response).toContain("Hiring scorer context.");
    expect(s.phase).toBe("answered");
  } finally { sessions.close(); }
});

test("opened notes attach automatically, searches and failed reads do not, removals survive restart", async () => {
  const root = vault(), contextRoot = nativeVault({ files: { "memory/project.md": "# Project\nProject context.", "memory/other.md": "# Other\nAnother note." } }); roots.push(contextRoot);
  let rounds = 0;
  const requests: any[] = [];
  const options = { contextRoot, graph: () => nodes, fetch: (async (_url: any, init: any) => {
    requests.push(JSON.parse(String(init.body)));
    if (requests.length === 2 || requests.length === 3) expect(s.context).toEqual(["dana"]);
    const outputs = [
      [call("search_vault", { query: "Project" })],
      [call("read_note", { path: "memory/missing.md" })],
      [call("load_memory", { topic: "project" })],
      [call("read_note", { path: "memory/project.md" })],
      [call("read_note", { path: "memory/other.md" })],
      [text("Done")],
    ];
    return stream([done(outputs[rounds++] ?? [text("Done")])]);
  }) as typeof fetch };
  const sessions = new PilotChats(root, options), s = sessions.create(["dana"]);
  sessions.send(s.id, "Read the project"); await sessions.settled(s.id);
  expect(s.phase).toBe("answered");
  expect(s.context).toEqual(["dana", "memory/project.md", "memory/other.md"]);
  expect(s.viewRevision).toBe(3); // Automatic title plus two idempotent attachments.
  expect(JSON.stringify(requests.at(-1))).toContain('memory/project.md');
  sessions.setContext(s.id, ["dana"], "Project", s.viewRevision);
  sessions.close();
  rounds = 2;
  const resumed = new PilotChats(root, options), restored = resumed.get(s.id);
  resumed.send(s.id, "Read it again"); await resumed.settled(s.id);
  expect(restored.context).toEqual(["dana"]);
  resumed.addContext(s.id, ["memory/project.md"]);
  expect(restored.removedContext).toEqual(["memory/other.md"]);
  expect(restored.context).toEqual(["dana", "memory/project.md"]);
  resumed.close();
});
