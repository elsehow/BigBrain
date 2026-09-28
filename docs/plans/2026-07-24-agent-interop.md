# Agent interop: `bigbrain connect` + the discuss loop

*2026-07-24. Status: **SUPERSEDED 2026-08-06** — do not inherit delivery
mechanics from this doc. Authoritative record: #45 (Claude Code plugin
delivery + `bigbrain connect`), #38 (per-harness integrations), #46–#48
(agent-chat capture chain). Still-valid core, carried forward there:
CLI + files + skills ordering; MCP as a later shim for shell-less
surfaces; stateless one-shot vault operations. The original header's
"companion decision note filed to the vault" is an anti-pattern — the
vault takes no engine decision notes; the design record is issues +
docs/plans.*

## Decision

BigBrain's agent interop surface is **CLI + files + skills**, in that
order. MCP is a thin compatibility shim we build later, only for
shell-less surfaces (claude.ai, ChatGPT desktop, mobile), on the official
SDK, after the 2026-07-28 spec revision settles into client support.

Why (short form — the decision note in the vault carries the discourse):

- Every terminal agent (Claude Code, Codex, Cursor, Gemini CLI, opencode)
  can shell out and read files. A CLI invocation costs ~200 tokens;
  big MCP servers dump tens of thousands of tokens of tool schema into
  context before any work happens. Evals put MCP at 4–32× the token cost
  of CLI equivalents for this class of use.
- Skills solve capability discovery without loading tool definitions:
  a short summary of what exists and where to learn more. The format is
  spreading across agents; where it hasn't, a generated slash command or
  instructions-file stanza is the same idea.
- The CLI+files path has zero exposure to MCP spec churn — relevant this
  month, since the 2026-07-28 revision breaks with the stateful design.
- We already have the hard parts: the `bigbrain` CLI verbs, the token
  store (`lib/auth.ts`), HTTP intake, the mirror.

Design rule inherited from the MCP-spec direction anyway: **every vault
operation is a stateless one-shot** (`search`, `read`, `drop`, `notify`).
No session state in any interop surface. This keeps the eventual MCP shim
a trivial wrapper.

## The user story

Signup is two steps: (1) chrome extension, (2) local agent env. This doc
is step 2. After `bigbrain connect`, the user's agents — in ANY project
directory, not just the vault — know the vault exists, can search/read
it, and can write to it through the sanctioned paths (drop / request /
notify). The vault's own CLAUDE.md remains the richer in-vault
experience; `connect` is what makes the vault reachable from everywhere
else.

## Deliverable 1: `bigbrain connect`

New verb, `bin/connect.ts`, registered in `bin/cli.ts`. Idempotent;
re-running repairs/refreshes. Four phases:

### 1a. Auth

Reuse `bin/login.ts` flow: token minted on the host (`bigbrain token
create --name "nick laptop" --scope vault:read --scope inbox:write
--scope outbox:write`), pasted once, verified against `/v1/whoami`,
stored 0600 in `~/.config/s-tier/client-tokens.json`. `connect` invokes
this when no valid token exists for `host.url`.

Scope design (the one real decision):

- Existing scopes are already right-shaped: `vault:read`,
  `inbox:write` (drop + requests — a request IS an inbox item),
  `outbox:write` (notify).
- Default mint for a personal client: all three. The disclosure risk of
  `outbox:write` is bounded host-side by the email send-allowlist, so a
  stolen laptop token cannot mail arbitrary recipients.
- No new scopes needed for v1. If/when third-party integrations get
  tokens, they get `inbox:write` only (status quo for the chrome
  extension).

Device-code auth (no paste) is a later polish item, not v1.

Connect's auth phase is also the **identity ceremony** — see § Sender
identity below: the token it mints is `--kind agent`, named by the agent,
owned by the user. Authorizing an agent and identifying it are one step.

### 1b. Mode: mirror or thin

- **Mirror** (default when git is available): today's client install —
  clone, pull timer, `.state/role = client`. Reads are local
  files; `bigbrain search` uses the local FTS index.
- **Thin** (no clone): CLI verbs ride HTTPS to the host —
  `search` → `/api/search`, reads → `/api/note`, drop/notify → intake.
  Requires: teach `bin/search.ts` and the read path a remote fallback
  when no vault root is discoverable but a client token exists. This is
  the commercial-tier default for non-git users; v1 can ship
  mirror-only if the remote-read seam gets big, but keep the CLI
  surface identical so thin mode is additive.

### 1c. Agent registration

Detect installed agents by directory probe, register the vault skill
globally per agent:

| Agent | Probe | Artifact |
|---|---|---|
| Claude Code | `~/.claude/` | `~/.claude/skills/bigbrain/SKILL.md` |
| Codex CLI | `~/.codex/` | `~/.codex/prompts/bigbrain.md` |
| Cursor | `~/.cursor/` | `~/.cursor/commands/bigbrain.md` |
| Gemini CLI | `~/.gemini/` | `~/.gemini/commands/bigbrain.toml` |
| opencode | `~/.opencode/` | `~/.opencode/command/bigbrain.md` |

All generated from **one template** in the engine
(`prompts/interop-skill.md` + per-agent wrappers), compiled with vault
specifics (vault path, host URL) — same compile-from-manifest pattern as
`install.ts`. Verify each target format at build time; treat all of this
as sugar, never load-bearing.

Template content (~30 lines): you have a persistent knowledge vault at
`<path>`; ground yourself with `bigbrain search <query>` then read the
hits with your file tools; add content via `bigbrain drop <file>` (with
frontmatter contract inline); request reorganization via `kind: request`;
notify via `bigbrain notify`; never write `domains/` or `library/`
directly. Plus the write-guard note for in-vault sessions.

Also: ensure `AGENTS.md → CLAUDE.md` symlink in the vault checkout so
non-CC agents working *in* the vault get the full instructions.

PATH check: `bigbrain` must resolve in non-interactive shells (known
gotcha from host deploys) — `connect` verifies and prints the fix.

### 1d. Smoke test

Run one `bigbrain search` round-trip and one `/v1/whoami`, print the
results. Exit nonzero with a named failure if either fails — loud, like
drop/notify.

## Sender identity: `from` × `via` (phase 1 implemented 2026-07-24)

Every vault is multi-sender — the user, their agents, integrations, the
engine itself — so items carry two axes, never conflated:

- **`from` / `from_kind`** — the principal: a person (verified
  identity), an agent (named delegate), or a service (a feed no person
  composed — granola, whoop; the integration names itself). Email is a
  TRANSPORT, not a sender: its principal is the allowlist-verified
  correspondent. What the home view tags and filters on.
- **`via`** — the channel/credential (`source`, `submitted_by`,
  `submitted_via`): the audit trail, unchanged.

**The one hard rule: a payload may claim to be an agent, never a
person.** Person identities come only from verified credentials — the
edge login's email, a token's `owner` — and forged `from_kind: person`
is stripped like any reserved key (`lib/intake.ts`). Agent names may be
self-asserted *through* any credential, because an agent only writes
under a credential the owner issued: the credential anchors
accountability, the name is display. This resolves the shared-laptop
problem — one token carries both the owner's web drops and their
agents' composed ones, and only the composer knows which.

Where identity comes from, per path:

| Path | `from` |
|---|---|
| Edge web drop | login email, stamped (verified person) |
| Token HTTP, `kind: agent` | token's name (the agent), stamped |
| Token HTTP, `kind: person-device` | token's `owner`, stamped |
| Token HTTP, legacy (no identity) | none — channel heuristic at read |
| ssh/local compose | self-asserted `from`/`from_kind: agent` in frontmatter (vault-add contract) |

`TokenRecord` gains `owner` (email) + `kind: person-device | agent`;
mint via `bigbrain token create --owner <email> --kind agent`. An agent
token REQUIRES an owner — every agent acts as someone's delegate.

The home view reads this as three bands: **You sent** (person) / **Your
agents sent** / **Engine & ingest** (editor churn, poll integrations).
Items predating the stamp fall back to a channel heuristic
(`claude-code` → agent; web/api/email → person; else engine). In a
shared vault the top band becomes per-person names — same schema,
which is the point.

Later phases: `notify`/outbox items carry `from` the same way; vault.yaml
sender→domain write policy for truly shared vaults (multi-tenant, not
now).

## Deliverable 2: the discuss loop (web UI)

The original pain point: user adds something via the viewer, wants to
chat about it immediately in their agent.

- `prompts/discuss.md` in the vault (human-editable, like triage/deep
  prompts): read the named note, follow its `[[links]]` one hop, open
  the `library/` sources it cites, then stop and wait — sounding-board
  stance, no unsolicited actions.
- Viewer note view + drop-success toast get a **Discuss** button that
  copies a plain-English line to the clipboard:
  `Read prompts/discuss.md and follow it for <vault-relative-path>`.
  Plain English because it works pasted into ANY agent, registered or
  not; agents with the skill installed don't even need it. Pure
  client-side `navigator.clipboard` — no server change, works under
  both the exe.dev edge and `ssh -L`.
- Pre-filing case: on drop success show **File now** → `POST
  /api/triage`; listen on `/api/events` for the item's filing; flip the
  button to **Discuss** with the real filed path. `prompts/discuss.md`
  must also handle a bare `inbox/` path explicitly ("not filed yet").

## Deliverable 3: MCP shim (parked)

Build when a shell-less surface matters commercially. Shape is fixed
now so nothing else has to move later:

- Official SDK, post-2026-07-28 revision, remote-capable.
- 4–5 tools, thin wrappers over the same verbs: `search_vault`,
  `read_note`, `drop`, `file_request`, `notify`. Stateless per call.
  Total schema budget target: well under 1k tokens.
- Auth: same token store, same scopes.

Do not build this in July/August. Positioning answer until then:
"claude.ai access via the web viewer; MCP connector coming."

## Sequencing

1. `prompts/discuss.md` + Discuss/File-now buttons (small, independent,
   kills the felt pain immediately).
2. `bin/connect.ts` — auth + mirror mode + agent registration + smoke
   test (mirror-only v1 is acceptable).
3. Thin mode (remote read/search fallback in the CLI).
4. MCP shim, on demand, ≥ September.

Verification per the `verify` skill: sandbox vault, run `connect`
against it with a scratch `~/.claude`/`~/.codex` HOME, confirm generated
artifacts parse in each agent; UI changes against the sandbox viewer.

## Open questions

- Skills format drift across agents — re-verify the table above at
  implementation time; it moves monthly.
- Thin-mode search: proxy FTS via `/api/search` is easy; thin-mode
  `Grep`-style exploration has no answer (no files) — acceptable, search
  + note-fetch covers the core loop.
- Does `connect` belong in /setup's interview flow? Probably yes as its
  final step on a client; keep the standalone verb regardless.
