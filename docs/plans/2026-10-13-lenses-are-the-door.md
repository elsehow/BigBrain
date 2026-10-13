# Lenses are the door

2026-10-13. Decided in conversation. Replaces the contained-desktops plan
(#274, never merged) and closes the stack built on it (#274–#298).

## The sentence

> BigBrain keeps the record and serves it. It runs no general-purpose
> agent: agents run elsewhere and read the vault through one door, the
> whole vault by default and a lens when you want less.

## Why

The risk worth designing for is an agent that holds private data, reads
untrusted content, and has a way out. Any two are fine; all three let a
page or an email instruct the agent to send the vault somewhere.

BigBrain's own agents have no way out. The gardener, the memory pass,
briefings, relations, Quick and Pilot run in pi sessions given only
BigBrain's tools (`lib/run/piSession.ts` enables `customTools` alone): no
shell, no web, no network. An injection through an arrival can put wrong
things in the record, which attribution, the gates and review already
guard; it has nowhere to send anything. A VM around them would protect
nothing.

The Desktop was the exception: a pi agent with web search and a shell.
Containing it is what #274–#298 built — a Linux VM per Desktop, a guest
agent, a macOS helper, an egress proxy. Removing the Desktop removes the
reason for all of it, and stock agents (Claude Code, Codex) do the agent's
job better than one we maintain.

An agent outside BigBrain is the opposite case: what it can do besides
reading is out of BigBrain's hands. So BigBrain's part is a door that says
plainly what it gives, a narrower door for anyone who wants one, and a
described setup — the Thinker, below — for the agent that reads both the
vault and the web.

## 1. Lenses on the Field

A lens is a named rule over the vault, its members a view over inclusion
assertions (`lib/lenses.ts`, `lib/views/lens.ts`). Today it is reached from
settings and from the gear's list, which mixes lenses with servers.

- Each lens draws as a cube, placed among its members the way
  `placePilots` places a Desktop's cube among its context.
- Clicking a cube filters the Field to the lens and opens what it holds:
  its rule, its members, and any review it holds.
- The gear's list keeps vaults only: Personal and the servers you have
  joined. Choosing a lens moves onto the Field.
- Shift-Return on a selection, which today starts a pilot on what's in
  hand, makes a lens of exactly that selection: the owner's pins, no rule.

Open: whether a server's view draws the lenses shared with that server.

## 2. One door: MCP over the local API

Today an agent connects through the plugin's stdio server
(`clients/claude-plugin/.mcp.json` → `scripts/local.sh`): a process on the
same machine, reading the vault off disk. Connected Clients
(`lib/connectedClients.ts`) already mints, lists, renews and revokes the
credentials those connections use.

- The local API (`bin/api.ts`, 127.0.0.1) serves MCP over HTTP, reusing the
  shared server's transport (`lib/sharedMcp.ts`). The credential is the
  bearer token Connected Clients mints.
- **The default grant is the whole vault: read (`vault:read`) and drop
  (`inbox:write`).** Never edit, never delete. That is how most people
  will use it, and it should not take a lens to start.
- Connecting shows one sentence before the token: this agent can read your
  whole vault; if it can also browse or send things, a page it reads could
  get it to send the vault out — use a lens, or the Thinker.
- "Copy connection" gives the command, e.g. `claude mcp add --transport
  http bigbrain http://127.0.0.1:<port>/mcp --header "Authorization: Bearer …"`.
- Connected Clients shows each agent's last read; revoking closes it.
- The stdio server retires once the Claude Code and Codex plugins use the
  door.

## 3. A lens as a grant

- A token can be bound to one lens. Every read through it answers inside
  the lens: note reads, search, entity pages, threads, briefings,
  relations, `load_memory`. An assertion is in only if every source it
  cites is in — the lens rule already. A thread or a copy group comes in
  only with its members.
- **Memory is never in a lens** (decided 2026-10-13, #303; this first read
  "unless the owner pins topics into it"). Memory summarizes the whole
  vault, so it is the widest leak in any narrow scope. Lines carrying
  citations could be filtered; the owner's own uncited lines cannot.
- Additions nobody made to a lens served to an agent are held for review,
  as Conservative mode already holds them for a shared lens
  (`LensReview`): a model's scoring decides what the agent reads.
- Drops through a lens token land in the vault attributed and untrusted;
  they do not widen the lens.
- An agent that cannot reach 127.0.0.1 — a kuggis box on exe.dev — reads a
  lens through a server it is shared with, over that server's existing
  read-only MCP. The lens is the unit either way.

## 4. Desktops go

- #274–#298 close; their branches stay for reference. #255 closes.
- Removed: `packages/agents`, `lib/codingDesktops.ts`, `lib/agentHost.ts`,
  `lib/desktopNetwork.ts`, `lib/webSearch.ts`, `bin/agent.ts`, and the
  Desktop UI (the chat column, Desktop settings, the bar's pilots). The
  cube passes to lenses.
- Pilot stays for now: it has no web and no shell. Its future is a separate
  decision.
- pi stays: the gardener and the memory pass run on it.

## 5. The Thinker

The agent that reads the whole vault and the web. It is kuggis's to set up
(elsehow/kuggis), as configuration of stock Claude Code; BigBrain only
supplies the door. What makes it acceptable:

1. **The vault only through the door** (§2), never off disk.
2. **Nothing else on the machine.** A separate macOS user (or a
   container) holding only a workspace: no home folder, 1Password, ssh
   keys, browser profiles or keychain.
3. **Its own model login, with no claude.ai connectors.** A token from
   `claude setup-token` loads none; a full login would bring Gmail, Drive
   and the rest, each a way out.
4. **Web without a way out.**
   - Search runs on Anthropic's side and returns titles and URLs: allowed.
   - Pages are read only at URLs that came from outside — search results,
     links in pages it read, the owner's messages — never a URL the model
     composed. A `PreToolUse` hook on WebFetch enforces it against the
     transcript. The transcript can lag the newest tool result, so the hook
     can refuse a fresh link once; it fails closed.
   - Bash runs in Claude Code's sandbox with `network.strictAllowlist` and
     no allowed domains: no network from the shell or its children.
5. **It acts only through what the owner reviews:** drops into the vault,
   and briefs for kuggis in an outbox the owner accepts. No mail, no
   GitHub writes, no messages.

What remains: a hostile page that offers many links can leak slowly
through which ones get followed. Capping fetches per page closes most of
it if that ever matters.

## Order

1. Lens cubes, the filter, the gear's list (UI over the lens view).
2. The door (§2).
3. A lens as a grant (§3).
4. Desktops go (§4), once the cubes have a new owner.
5. The Thinker in kuggis, once the door exists.
