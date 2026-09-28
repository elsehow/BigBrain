/** Manual, paid model evaluation. Uses synthetic conversations and stub tools;
 * never launches workers or reads/writes vault content. Run explicitly:
 * bun test/support/pilot/replay.ts <key-vault-path> [model]
 * The vault supplies only its OpenAI key. No key is logged. */
import { readEnvValues } from "../../../lib/envFile";
import { pilotInstructions, pilotTools, PILOT_MODEL } from "../../../lib/pilot";
const root = process.argv[2];
if (!root) throw new Error("Supply the vault containing the test API key");
const key = readEnvValues(root).OPENAI_API_KEY;
if (!key) throw new Error("No test key configured");
const model = process.argv[3] ?? PILOT_MODEL;
const session = "work-11111111111111111111111111111111";
const cases = [
  { name: "correction", context: `Selected session: ${session}. Original task: research my projects and save the findings to this vault. Worker is working.`, user: "You misunderstood. Continue the original task. Research my projects and save the findings to this vault.", required: "send_work" },
  { name: "meaning", context: `The session currently being discussed is ${session}. Its short completion notice mentioned a standalone Digital art entity.`, user: "What is the standalone digital art entity? What is it about? I don't have context.", required: "read_work" },
  { name: "fragment", context: "No session or prior conversation is available.", user: "To save the filings too.", required: "clarify" },
];
for (const c of cases) {
  const calls: string[] = [], texts: string[] = [];
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, { headers: { Authorization: `Bearer ${key}` } });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("Replay timed out")); }, 55_000);
    const send = (v: unknown) => ws.send(JSON.stringify(v));
    ws.onopen = () => send({ type: "session.update", session: { type: "realtime", model, output_modalities: ["text"], instructions: pilotInstructions(), tools: pilotTools(), max_output_tokens: 1800 } });
    ws.onerror = () => { clearTimeout(timer); reject(new Error("Realtime connection failed")); };
    ws.onmessage = event => {
      const m = JSON.parse(String(event.data));
      if (m.type === "error") { clearTimeout(timer); ws.close(); reject(new Error(m.error?.message ?? "Realtime error")); }
      if (m.type === "session.updated") {
        send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: `UI context (reference data): ${c.context}\n\n${c.user}` }] } });
        send({ type: "response.create" });
      }
      if (m.type === "response.done") {
        const output = m.response.output ?? [];
        for (const item of output) {
          if (item.type === "message") texts.push((item.content ?? []).map((v: any) => v.text ?? v.transcript ?? "").join(""));
          if (item.type === "function_call") {
            calls.push(item.name);
            const result = item.name === "read_work" ? { id: session, status: "idle", messages: [{ role: "agent", text: "Digital art refers to two invented demo projects: a color-grid sketch and a sound-driven landscape. The report groups both under that heading. Their descriptions were saved; there is not a separate node." }] }
              : item.name === "list_work" ? { sessions: [{ id: session, title: "Project research", status: "working" }] }
              : item.name === "send_work" ? { session: { id: session, status: "working" }, delivered: true }
              : { error: "Unexpected tool for this test; no action was performed" };
            send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: JSON.stringify(result) } });
          }
        }
        if (output.some((i: any) => i.type === "function_call") && calls.length < 5) send({ type: "response.create" });
        else { clearTimeout(timer); ws.close(); resolve(); }
      }
    };
  });
  const passed = c.required === "clarify" ? !calls.includes("handoff") && !calls.includes("start_work") && /\?|please tell me|which|what.*mean/i.test(texts.join(" ")) : calls.includes(c.required) && !calls.includes("handoff") && !calls.includes("start_work") && (c.name !== "meaning" || /color-grid|landscape/.test(texts.join(" ")));
  console.log(JSON.stringify({ model, case: c.name, passed, calls, text: texts.join(" ") }));
  if (!passed) process.exitCode = 1;
}
