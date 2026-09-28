import { sha256hex } from "../lib/hash";
import { deactivateIntegration } from "../lib/integrationAccess";
import { stagedHeads } from "../lib/stage";
import { fakeIntegrationActivation } from "./support/integrationActivation";
/** Drive the shipped entry point, with only fetch replaced in its process.
 * The fixture cannot read a real vault or make a network request. */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { integrationStatus } from "../lib/integrationStatus";
import { readSourceInsertionLog } from "../lib/insertionLog";

test("Granola's actual runner reports quiet checks, arrivals, errors, recovery and the off gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "bb-granola-run-"));
  const preload = join(root, "fetch.ts");
  writeFileSync(join(root, "vault.yaml"), "integrations:\n  granola: {}\n");
  writeFileSync(join(root, ".env"), "GRANOLA_API_KEY='synthetic'\n");
  fakeIntegrationActivation(root, "granola");
  const run = async (mode: "quiet" | "arrival" | "error" | "invalid" | "forbidden") => {
    writeFileSync(preload, `globalThis.fetch = async (_url, init) => {
      const mode=${JSON.stringify(mode)};
      if(mode === "forbidden") throw new Error("network called while disabled");
      if(mode === "error") return new Response("", {status:503});
      if(init.method==='GET')return new Response(null,{status:405});
      const m=JSON.parse(init.body);
      if(m.id===undefined)return new Response(null,{status:202});
      let result={};
      const text=t=>({content:[{type:'text',text:t}]});
      if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
      if(m.method==='tools/list')result={tools:['get_account_info','list_meetings','get_meetings'].map(name=>({name,inputSchema:{type:'object'}}))};
      if(m.method==='tools/call'){
        const id='11111111-1111-4111-8111-111111111111';
        if(m.params.name==='get_account_info')result=text(JSON.stringify({workspace:'fixture'}));
        if(m.params.name==='list_meetings')result=text(mode==='invalid'?'invalid':mode==='arrival'?'<meetings_data count="1"><meeting id="'+id+'" title="Fixture meeting" date="2026-09-12T12:00:00Z"></meeting></meetings_data>':'<meetings_data count="0"></meetings_data>');
        if(m.params.name==='get_meetings')result=text('<meetings_data count="1"><meeting id="'+id+'"><summary>Decision</summary></meeting></meetings_data>');
      }
      return Response.json({jsonrpc:'2.0',id:m.id,result});
    };`);
    const proc = Bun.spawn([process.execPath, "--preload", preload, resolve("integrations/granola/run.ts"), "--since", "2026-09-01T00:00:00Z"], {
      env: { ...process.env, BIGBRAIN_VAULT: root }, stdout: "pipe", stderr: "pipe",
    });
    const [, , code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return code;
  };
  try {
    expect(await run("quiet")).toBe(0);
    expect(integrationStatus(root, "granola", true, true)).toMatchObject({ state: "ok", label: "Up to date" });
    expect(await run("arrival")).toBe(0);
    expect(readSourceInsertionLog(root)).toHaveLength(0);
    expect(stagedHeads(root)).toHaveLength(1);
    expect(integrationStatus(root, "granola", true, true).lastArrivalAt).toBeTruthy();
    const cursor = readFileSync(join(root, ".spool/integration-cursors/granola-mcp-"+sha256hex("granola").slice(0,24)+".json"), "utf8");
    expect(await run("error")).not.toBe(0);
    expect(integrationStatus(root, "granola", true, true).state).toBe("error");
    expect(readFileSync(join(root, ".spool/integration-cursors/granola-mcp-"+sha256hex("granola").slice(0,24)+".json"), "utf8")).toBe(cursor);
    expect(await run("invalid")).not.toBe(0);
    expect(await run("quiet")).toBe(0);
    writeFileSync(join(root, "vault.yaml"), "integrations:\n  granola:\n    enabled: false\n");
    deactivateIntegration(root,"granola");
    rmSync(join(root, ".state/integrations/granola.json"));
    expect(await run("forbidden")).toBe(0);
    expect(existsSync(join(root, ".state/integrations/granola.json"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
