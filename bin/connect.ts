#!/usr/bin/env bun
/** Named local MCP connections replace the legacy plugin installer. */
import { ConnectedClients } from "../lib/connectedClients";
import { VAULT_ROOT } from "../lib/vaultRoot";
import { flagValue, hasFlag } from "../lib/cliflags";
const argv=process.argv.slice(2);
if(hasFlag(argv,"help")||argv.includes("-h")){
  console.log("usage: bigbrain connect [--agent claude|codex] [--name <connection name>]");
  console.log("Print a named local MCP setup command, also available in Settings → Connected Clients.");
  process.exit(0);
}
if(["owner","url","no-plugin"].some(flag=>hasFlag(argv,flag)||flagValue(argv,flag)!==undefined))throw new Error("Legacy plugin options are retired. Use Settings → Connected Clients to replace an existing plugin connection.");
const agent=flagValue(argv,"agent")??"claude";
if(agent!=="claude"&&agent!=="codex")throw new Error("--agent must be claude or codex");
const clients=new ConnectedClients(VAULT_ROOT);
const setup=clients.ensure(flagValue(argv,"name")??(agent==="codex"?"Codex":"Claude Code"),agent==="codex"?"codex":"claude-code","cli:connect:"+agent);
console.log(setup.instructions);
console.log(setup.command);
