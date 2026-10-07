import { withGranola, GRANOLA_READ_TOOLS } from "./granolaMcp";
/** One account-scoped dispatch boundary shared by Pilot, gardener and MCP. */
import { LIVE_ACCESS_DESCRIPTIONS } from "./integrationAccounts";
import { LIVE_INBOX_TOOLS, liveInboxTool, type InboxClientFactory } from "./liveInbox";
import { writableIntegrationAccounts, readableIntegrationAccounts, requireIntegrationWrite, requireIntegrationRead, type IntegrationCaller } from "./integrationAccess";
import { createEmailReadStateAdapter } from "./emailReadState";
import { createSourceReadStateService } from "./sourceReadState";
import { sourceCatalog } from "./vaultReadModel";
import { liveForAgent, liveOrigin } from "./agentReads";

export const INTEGRATION_TOOLS = [
  {name:"integration_capabilities", description:"List the live source accounts this caller can read. This does not read source content or save evidence.", inputSchema:{type:"object",properties:{},additionalProperties:false}},
  ...LIVE_INBOX_TOOLS,
  {name:"granola_tools",description:"Discover current Granola MCP read tools and their input schemas for one granted account. Reads do not remember evidence.",inputSchema:{type:"object",properties:{account:{type:"string"}},required:["account"],additionalProperties:false}},
  {name:"granola_read",description:"Call a Granola read tool using the exact name and arguments returned by granola_tools. Reads current meeting notes, transcripts or folders; does not change meetings or remember evidence.",inputSchema:{type:"object",properties:{account:{type:"string"},tool:{type:"string"},arguments:{type:"object",additionalProperties:true}},required:["account","tool","arguments"],additionalProperties:false}},
  { name: "source_read_state", description: "Read live read/unread flags for stored messages in one granted email account. Does not change mail or remember evidence.",
    inputSchema: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false } },
];
export function integrationCapabilities(root: string, caller: IntegrationCaller) {
  const accounts = readableIntegrationAccounts(root, "email", caller);
  return { email: { accounts, descriptors: LIVE_ACCESS_DESCRIPTIONS.email, accountAccess: accounts.map(account=>({account,access:writableIntegrationAccounts(root,"email",caller).includes(account)?"read-write":"read"})), available: !!accounts.length, operations: ["inbox_list", "inbox_read", "email_search", "email_read", "source_read_state", ...(writableIntegrationAccounts(root,"email",caller).length>0?["inbox_set_unread"]:[])], access: "Per-account grants; write operations require read+write" },
    granola:{accounts:readableIntegrationAccounts(root,"granola",caller),available:readableIntegrationAccounts(root,"granola",caller).length>0,descriptors:LIVE_ACCESS_DESCRIPTIONS.granola,operations:["granola_tools","granola_read"]},
    remembering: "Live reads do not save evidence. Use drop explicitly; the gardener owns admission and filing." };
}
/** What a content read's results are, for the provenance every agent-facing result carries (lib/agentReads.ts). */
const origin = (name: string) => { const kind = liveOrigin(name); return kind ? { kind, trusted: false } : {}; };
export interface IntegrationCallOptions { signal?: AbortSignal; client?: InboxClientFactory; granola?: {endpoint?:string} }
export async function integrationToolCall(root: string, caller: IntegrationCaller, name: string, args: Record<string, unknown>, options: IntegrationCallOptions = {}): Promise<unknown> {
  if (!INTEGRATION_TOOLS.some(t => t.name === name)) throw new Error("This integration operation is not available.");
  if (name === "integration_capabilities") return integrationCapabilities(root, caller);
  if(name==="granola_tools"||name==="granola_read"){
    const account=String(args.account??"");
    const check=()=>requireIntegrationRead(root,"granola",account,caller);
    check();
    const controller=new AbortController(), signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
    const timer=setInterval(()=>{try{check();}catch{controller.abort();}},100);timer.unref?.();
    try{
      const result=await withGranola(root,account,async(client,tools)=>{
        const reads=tools.filter(t=>GRANOLA_READ_TOOLS.has(t.name));
        check();signal.throwIfAborted();
        if(name==="granola_tools")return reads;
        if(!reads.some(t=>t.name===args.tool))throw Error("Choose an available Granola read tool.");
        if(!args.arguments||typeof args.arguments!=="object"||Array.isArray(args.arguments))throw Error("Provide the tool arguments.");
        return client.callTool({name:String(args.tool),arguments:args.arguments as Record<string,unknown>},undefined,{signal});
      },{...options.granola,signal});
      check();signal.throwIfAborted();
      return {provenance:{integration:"granola",account,scope:"live_source",checkedAt:new Date().toISOString(),remembered:false,...origin(name)},result:liveForAgent(name,result)};
    }finally{clearInterval(timer);}
  }
  let account = typeof args.account === "string" ? args.account.toLowerCase() : "";
  if (name === "inbox_read" || name === "email_read" || name === "inbox_set_unread") {
    try { account = JSON.parse(Buffer.from(String(args.ref), "base64url").toString()).account; }
    catch { throw new Error("Invalid inbox reference; list the inbox again."); }
  }
  if (!account) {
    const accounts = readableIntegrationAccounts(root, "email", caller);
    if (accounts.length === 1) account = accounts[0]!;
  }
  const check = () => name === "inbox_set_unread" ? requireIntegrationWrite(root,"email",account,caller) : requireIntegrationRead(root, "email", account, caller);
  check(); options.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setInterval(() => { try { check(); } catch { controller.abort(); } }, 100);
  timer.unref?.();
  try {
    const result = name === "source_read_state"
      ? await createSourceReadStateService([createEmailReadStateAdapter(options.client, {authorize:check, signal})], {
        sources: () => sourceCatalog(root).sources.filter(s => s.envelope.inbox === account),
      }).refresh(root, true).then(rows => rows.map(row => ({...row, readState: {...row.readState, writable: false}})))
      : await liveInboxTool(root, name, { ...args, account }, { ...options, signal, authorize: check });
    try { check(); signal.throwIfAborted(); } catch(error) { if(name==="inbox_set_unread")throw new Error("Access changed after the provider operation. The flag may have changed; inspect current state before retrying.");throw error; }
    return { provenance: { integration: "email", account, scope: "live_source", checkedAt: new Date().toISOString(), remembered: false, ...origin(name) }, result: liveForAgent(name, result) };
  } finally { clearInterval(timer); }
}
