# Claude Code integration (#45 read-side) — plan of record

> **HISTORICAL (2026-08-30, #644).** This plan shipped; the surfaces it describes have since been reshaped (#479/#495/#498), and its hosted-era details live at tag `hosted-multitenant-final`.

Date: 2026-08-10 · Status: **plan** · Owner: Nick + Claude
Issues: #45 (this slice) · #38 (the funnel half: trigger + card) · #86, #105
(the substrate, both shipped 2026-08-10) · #47/#46/#48 (capture-side, later)

## The slice

The last unbuilt step of the onboard funnel: *encounter → extension → sign in
→ add stuff → UI shows things linking → **connect an agent***. Onboard ships
the **Claude Code card only** (Nick, 2026-08-10); the remote-connector track
(#87, #88, #89, #90) moved to its own `connectors` milestone, with #88
near-term for claude.ai (see Decisions). #91 is capture-side and belongs with
#47, not with that arc.

Done means: a user runs one command, and from then on every Claude Code
session in any directory opens with their memory index and can search and
add to their vault over HTTP.

Capture-side — the SessionEnd poke and transcript watching — is explicitly
NOT in this slice. It rides #47 (with #46 and #48) and is a different arc.

## What already exists (verified 2026-08-10)

The substrate is complete. This plan adds no tenant-API routes.

| Piece | Where |
|---|---|
| `POST /v1/drop` | `lib/api.ts` — the `vault-add` skill needs nothing new |
| `GET /v1/search?q&n` | `lib/api.ts` (#86, shipped today) |
| `GET /v1/memory[?path=]` | `lib/api.ts` (#105, shipped today) |
| Token minting | `lib/auth.ts` — `mintToken(store, root, name, scopes, {owner, kind})` |
| Browser→token handoff | `control/ext.ts` `/ext/finish`: authenticates the Google session, provisions the tenant, mints a token, 302s back with `#token=…&api_base=…&email=…` |
| CLI token storage | `bin/auth.ts` — `bigbrain auth login` pastes a token, verifies it against `/v1/whoami` BEFORE saving, stores 0600 in `~/.config/s-tier/client-tokens.json` keyed by host url |
| The viewer | `/app` (#96), with `IntegrationsView.svelte` rendering per-integration cards |

Not present: the agents tab (`/app/connect` was specified in
`docs/plans/2026-08-09-product-shell-v1.md` §4 and never built — `shell/`
was deleted when `/app` became the real viewer; it lands as a settings tab
instead, §4), the `GET /connect` installer, and the plugin itself. There is
no `bigbrain connect` verb and this slice does not add one (decision 7).

## The six pieces

### 1. The plugin, carried by the installer — no marketplace repo

**The installer writes the plugin to disk and registers that directory as a
local marketplace** (Nick, 2026-08-10, superseding "a NEW repo"). No public
repo, no private repo, no clone.

Verified 2026-08-10 against Claude Code 2.1.226, with `git` absent from
`PATH` entirely and an isolated `CLAUDE_CONFIG_DIR`:

```
$ claude plugin marketplace add <dir>          ✔ added: bbtest    exit 0
$ claude plugin install bbtest@bbtest --scope user
                                               ✔ installed        exit 0, enabled: true
```

This is what makes the whole flow work on a machine with nothing on it.
`claude plugin marketplace add` **clones** a GitHub source, so a repo-backed
marketplace needs `git` — and on a fresh Mac `/usr/bin/git` is the Command
Line Tools stub, which raises a GUI modal a piped script cannot answer. A
directory source never invokes git, so that failure path does not exist.

It also collapses the release channel: the plugin ships inside the script
control already serves, so **deploying the control plane is shipping the
plugin.** No tags, no releases, no version skew between CLI and plugin. The
cost is that a directory marketplace does not auto-update from a remote —
updating means re-running the one-liner, which is simpler than the
`autoUpdate` merge a repo would have needed.

Contents, written to `~/.bigbrain/plugin/`:

- **`vault-search` and `vault-add` skills** that speak HTTP + token and never
  touch the filesystem. That is what makes them work from any directory,
  which is the whole point of #45. `vault-search` → `GET /v1/search` then
  `GET /v1/note`; `vault-add` → `POST /v1/drop`.
- **A SessionStart hook** that fetches `GET /v1/memory` and writes it to
  stdout, which Claude Code injects as model-visible context. **Budget it
  under 8,000 characters.** Measured 2026-08-10: SessionStart stdout is
  capped near 10,000 — past it, Claude Code spills to a file and injects a
  path instead, so 7.5 KB reached the model and 52 KB did not. The memory
  index would degrade silently as a vault grows. Truncate, and end with an
  explicit "ask `vault-search` for more."
- **`scripts/`**, POSIX `sh` + `curl`, each reading the token out of
  `~/.config/s-tier/client-tokens.json` **inside the script**. The token
  never reaches a command line and no skill body tells Claude to print it.

No `bin/` shim named `bigbrain`: on a host checkout it would shadow, or be
shadowed by, the real CLI symlink, invisibly. Nothing this slice needs
requires the CLI on the user's machine — see §2.

**These two skills replace the scaffolded pair, they do not join it.**
`lib/scaffold.ts` copies `.claude/skills/vault-search` and `vault-add` into
every provisioned vault, and both went stale at the lake refactor: they send
agents to `domains/`, `library/`, `inbox/`, and `git log --author=triage`,
and `vault-add` says "triage routes it by matching the domain descriptions
in `vault.yaml`" — a pass, a tree layout, and a routing mechanism that all
no longer exist. They are actively misleading every agent that reads them
today. So: **`scaffoldVault` stops copying them, and the HTTP pair takes the
names** the vault's own CLAUDE.md already points at, which keeps that file
correct with no edit. `setup` and `verify` are engine/config skills and are
untouched.

One set of skills, one way to do it, whether the agent is in the vault, in
some project directory, or on a machine that has never seen a checkout. The
HTTP surface loses nothing: `/v1/note` resolves links, `/v1/file` and
`/v1/ls` read the jail, `/v1/blob/<sha256>` fetches originals,
`/v1/memory` reads the working set. Only `git log` and arbitrary `grep` are
local-only, and an agent in a checkout can already run both without a skill
telling it to.

### 2. `GET /connect` — the one command

The whole first run is four steps, and the user types on only one of them:

1. Click **Connect** on the card. The consent copy is on the card, so the
   click IS the accept (§5).
2. Copy one line. The claim code rides inside it — there is no second field
   to copy.
3. Run it in a terminal.
4. Open Claude Code and ask *"what do you know about me?"*

One paste, and no keystroke between the paste and the payoff.

**There is no CLI to install** (Nick, 2026-08-10). #45 lists "installs the
CLI" as step 1, and this plan repeated it — but §1 above already says the
system-installed CLI is only needed for the out-of-session watcher, which is
capture-side. Nothing in the read-side needs `bigbrain` on the user's
machine: the skills speak HTTP, the hook speaks HTTP, and the token is one
JSON file. **Step 1 was the entire blocker and it was never load-bearing.**
Deleting it removes the artifact problem outright — no compiled binary, no
npm package, no release process, no version skew.

The card shows one line. Everyone gets the same one, whether or not they
have a checkout, because the script is idempotent and needs nothing present:

```
curl -fsSL https://bigbrain.cool/connect | BB_CODE=BB-7F3K-2M9Q-X4TB sh
```

**The code rides an environment variable, not `argv`.** Same one line, same
one paste — but `sh -s -- BB-…` puts a live credential in `ps` output that
any other user on the machine can read for its full ten minutes, and
`/proc/PID/cmdline` is world-readable on Linux. `environ` is owner-only.
The UX is identical, so there is nothing to trade.

The script, in order:

1. **Refuse to run as root.** Never `sudo`; nothing here needs it.
2. **Redeem the claim code** for an agent-kind token (§3, §6).
3. **Verify before storing**: `GET /v1/whoami`, distinguishing network error
   / 401 / other non-ok, exactly as `bin/auth.ts` already does. Only then
   write `~/.config/s-tier/client-tokens.json` at 0600. Storing first and
   probing after would leave a live credential on disk after telling the
   user it failed.
4. **Print the consent terms as a receipt** (§5) — a restatement of what the
   card already showed, not a prompt. Nothing to answer.
5. **Write the plugin and register it** — plugin files to
   `~/.bigbrain/plugin/`, then `claude plugin marketplace add` that
   directory + `claude plugin install … --scope user`. User scope so it
   applies in every project. **Do not hand-write `extraKnownMarketplaces` /
   `enabledPlugins` as a fallback**: verified 2026-08-10 that those settings
   keys alone, without Claude Code's own `plugins/` state files, leave
   `claude plugin list --json` returning `[]` — the fallback would report
   success and install nothing. The real commands are already
   non-interactive, so it has no reason to exist.
6. **Round-trip probe**: `GET /v1/search` (200), `GET /v1/memory` (200, raw
   markdown — not JSON), `POST /v1/drop` (**200**, not 201). **Configured
   means verified, not asserted.**

Wrapped in `main() { … }; main "$@"` on the final line, so a truncated
download defines nothing and executes nothing. Fetched with `--proto
'=https' --proto-redir '=https'` — nothing in the tree sets HSTS, and `-L`
would otherwise follow a cross-scheme redirect.

**Four failure paths decide whether this feels good or cheap.** They are
requirements, not polish:

- **No `claude` on the machine** — do NOT abort. Store the token, say plainly
  that the vault is reachable now and the plugin needs Claude Code, print the
  one command to finish later.
- **Code expired** — say so and say to click Connect again. Never surface a
  raw HTTP error, and never say "invalid code": redeem answers one
  undifferentiated 400 for unknown/spent/expired, and a mint failure burns
  the code, so a retry legitimately 400s on a code that was fine.
- **Already connected** — grep the token store for an existing tenant key
  BEFORE redeeming, and prompt via `/dev/tty` (a piped script's `read`
  otherwise eats its own next line). With no controlling tty — `ssh -T`, CI,
  the case §6 exists to serve — default to NOT replacing and print the
  instruction. v1 overwrites the local record only; revoking the old token
  is the card's job, which makes §4's token list a v1 requirement.
- **Won't pipe a script to `sh`** — some people won't, correctly. Serve
  `/connect` as `text/plain` with `Cache-Control: no-store` so the URL is
  readable in a browser, and publish the script's SHA-256 next to the copy
  line on the card. That is the "see what this runs" expander, made real.

**End on the aha, not on `✓ configured`.** The probe proves plumbing; the
user's moment is the first question answered from their own vault. `connect`
closes by telling them to open Claude Code and ask *"what do you know about
me?"* — and the agents tab flips live to **Connected — Claude Code
on `<hostname>`, just now**, so the confirmation lands in the browser they
are already looking at, not only in a terminal they may have closed.

### 3. Token kind — mint `kind: agent`, not `person-device`

`/ext/finish` mints `person-device` because the extension IS the person
clipping a page. A Claude Code plugin is not. `lib/api.ts`'s drop path stamps
`from` / `from_kind` from the TOKEN, and the editor and memory passes weight
user voice above every other signal. A plugin token minted `person-device`
would stamp every agent-authored drop as Nick-the-person, turning agent
paraphrase into false user-voice in his own memory — precisely the failure
the vault's door-fidelity rule exists to prevent.

So: `kind: agent`, scopes `vault:read` + `inbox:write`. The agent's own name
becomes the item's `from:`, which is correct and auditable.

### 4. The UI card — Settings → **agents** (`#/agents`)

Not `/app/connect`, and not a row inside `IntegrationsView`. **Its own tab
in the settings rail, first** — Nick, 2026-08-10, superseding this plan's
earlier standalone page. `AgentsView.svelte`, alongside `IntegrationsView`,
under the chrome `SettingsRail` already provides.

The split is direction of travel: **agents act ON the vault** (outbound
credentials, with a revoke and a `last_used`), **integrations feed INTO it**
(`vault.yaml`-declared inbound pollers, with an enable toggle and a config
editor). Different data, different verbs — which was the original objection
to one merged list, and a sibling tab honors it while reusing the
navigation.

The deciding argument is one the standalone page loses: **the `connectors`
milestone produces three more of these.** #87 is stdio clients (Claude
Desktop, Cursor, Windsurf); #88/#89 is claude.ai. Each needs the same verbs
and the same home. A tab absorbs them as rows. A page called `/app/connect`
does not — we would build the tab anyway and orphan the page.

The tab carries — all **SHIPPED**, #121:

- **the consent copy, above the button** (§5) — this tab is the consent
  surface, not the terminal;
- **a Connect button that mints the claim code** (§6) and reveals the one
  line to copy. Nothing is minted until it is clicked, so the click is a
  real act and not decoration;
- live connection state, derived from the token store — an `agent`-kind token
  with a recent `last_used`. While a code is live the card polls, so the
  confirmation lands in the browser the user is already looking at rather
  than only in a terminal they may have closed;
- the token list with revoke, over `GET /connect/tokens` and
  `POST /connect/revoke`.

~~the extension install link, which shell v1 §4 assigned to
`/app/connect`~~ — **moved to integrations, #117.** The extension is an
inbound capture path, so by this section's own boundary it belongs on the
other tab. `GET /connect/tokens` returns every kind for exactly that reason:
one endpoint, both tabs.

#38's after-N-adds trigger routes a user here by deep link (`#/agents`).
Settings is where you go deliberately, so the nudge must land inside the
tab rather than leave the user to find it.

**Settings → editor is gone** (Nick, 2026-08-10). It was live and writable:
model, debounce, and both prompt texts, saved and committed on the host. On
the hosted plane that is a tenant-controlled spend lever and a foot-gun — a
broken prompt fails runs, and the warden suspends the tenant after three.
There is no plane flag to hide it behind (`ConfigInfo.role` is `host` |
`client`, which is vault topology: a bigbrain.cool tenant reports `host`,
same as a self-hoster), so the choice was delete or keep, and it is delete.
`prompts/` stays human-edited on disk for anyone running their own host.

### 5. The consent copy

Hooks fire silently once a user-scope plugin is enabled, and non-interactive
install skips even the interactive "will install" manifest (#45). So the
entire consent burden sits on this slice. The question is where to put it.

**Consent lives on the card, and the Connect click is the accept** (Nick,
2026-08-10). The browser is the better surface for it on every count: the
user is already reading there, it has formatting a terminal does not, the
copy sits next to the revoke control it describes, and the click that mints
the claim code is a real authorizing act rather than decoration. A terminal
y/n prompt would be a second accept for one decision — and it would land in
the one place where it costs the most, between the paste and the aha.

So `connect` **restates** the terms as a receipt and continues. It asks
nothing. The user's last screen is the aha line, not a prompt.

The terms, in both places: every Claude Code session loads the memory index,
the agent can search the vault and add to it, and — once capture ships —
sessions in the chosen directories are captured. Session-level opt-out is
decided before the session, never scrubbed after.

**All four ship, capture included, even though capture is not built** (#122).
#121 shipped only the first three — naming a capability that does not exist
looked like the honest call, and it was the wrong one. Capture is settled,
not speculative: #47, *"agent sessions, opt-in, land in the lake as
`agent-chat`"*, locked 2026-08-06, which assigns its consent language to
precisely this flow. The card and the receipt are the ONLY places consent is
collected, so a user who reads these terms today and later finds their
sessions being filed was never asked. Future tense is the honest form;
omission is not. The sentence carries its own limits — chosen directories
only, opt-out decided before the session — so it grants nothing #47 will not
also enforce.

One exception keeps a prompt: **already connected** (§2). Replacing an
existing agent token is a destructive act on something the user has, not a
grant of something new, so it asks.

### 6. The claim-code handoff (control) — **SHIPPED**

`control/connect.ts`, `POST /connect/claim` + `POST /connect/redeem`. What
follows is the design; the code is the record.

The page that shows the command **already knows who the user is** — they
reached Settings → agents through a live Better Auth session. So the browser
mints the credential and the CLI redeems it; the CLI never opens a browser
of its own.

- `POST /connect/claim` is **session-gated** and mints a one-time code
  (`BB-7F3K-2M9Q-X4TB`) for the caller's active tenant, TTL 10 minutes.
- `POST /connect/redeem` takes **no session** — the code IS the credential,
  which is what lets it work over ssh. It returns one agent-kind token plus
  `api_base`, `email`, and `tenant_id`.
- The code, not the token, is what rides the clipboard and shell history —
  and it is dead on first use and after its TTL.

Four properties carry this seam, and each is pinned by a test:

- **No token exists until redeem.** Claim writes a code row and nothing else,
  so a code the user never pastes leaves no live credential behind.
- **Only the sha256 is at rest.** The registry holds exactly one plaintext
  credential (`tenants.shell_token`, which control must *present*); a claim
  code is *verified*, so it is hashed like `drop_token_sha256`.
- **Single use is enforced in the registry, not the route.** The check and
  the burn share one transaction, so two racing redeems cannot both win. A
  burn that then fails to mint is not un-burned: the user clicks Connect
  again, and a code never mints twice.
- **No oracle.** Unknown, spent, expired, and malformed all answer the same
  400. Distinguishing them would tell a guesser which codes exist.

**The code is 12 glyphs (Crockford base32), not 8.** 60 bits, because this
redeems for a live vault token. At 8 glyphs a 10-minute window gives an
online attacker ~5e-6 per window against a hundred outstanding codes — call
it a coin flip over a year of sustained attack, which is not a thing to ship
on a credential. At 12 it is ~5e-15. The extra glyphs cost nothing: the code
is copied inside the command, never typed. I/L fold to 1 and O to 0 on the
way in, for whoever reads the two-step version aloud.

This is what removes the browser round-trip from the CLI: no loopback
listener, no paste-a-token, no second sign-in, and it works over ssh where
there is no browser to open.

## Decisions

**1. Token handoff: the claim code (§6).** Settled by Nick, 2026-08-10,
superseding this plan's original "paste first, loopback later." Paste is a
wart and the loopback listener is surface we would build twice; the claim
code is better than both and is not something #88 later replaces.

**2. Connect does NOT ride #88's OAuth**, even though #88 is now
near-term (below). OAuth solves delegated authorization to a third party you
do not control; the connect script is first-party software the user just ran
on their own machine. Riding OAuth would ADD an authorize page and a
scope-consent screen — friction with no matching safety gain. The two
concerns separate cleanly: schedule #88 for claude.ai, design connect on its
own terms.

**3. #88 is near-term, for claude.ai — not for this slice.** Nick,
2026-08-10: claude.ai talking to the vault within the month, to onboard the
next round of less technical users. That sets #88's priority in the
`connectors` milestone. It does not change anything in this plan.

**4. Consent lives on the card; the Connect click is the accept.** Nick,
2026-08-10, revising this plan's earlier "`connect` states the terms before
writing anything." The terminal restates them as a receipt and asks nothing —
see §5 for why the browser is the better consent surface. This is what makes
the first run four steps with one paste and no keystroke before the payoff.

**5. The card is a Settings → agents tab, and Settings → editor is
deleted.** Nick, 2026-08-10, superseding this plan's standalone
`/app/connect` view. Agents and integrations are siblings split by direction
of travel, and the tab is what the rest of the `connectors` milestone will
land in. See §4.

**6. ~~The marketplace repo is public.~~ MOOT — there is no marketplace
repo.** Nick, 2026-08-10: internalize it. The installer writes the plugin to
`~/.bigbrain/plugin/` and registers that directory (§1). Public-vs-private
was a real question only while a repo existed; a directory source has no
repo to gate, no PAT in the install path, and — the reason it wins — needs
no `git`, which a fresh Mac does not have.

**7. There is no CLI to install, and no CLI artifact in this slice.** Nick,
2026-08-10. See §2. The read-side needs HTTP and a token file, nothing more.
This supersedes #45's own step 1 and closes the question of how to publish a
binary: we do not.

**8. One set of skills, over HTTP, and the scaffolded pair is deprecated.**
Nick, 2026-08-10: *"plan to deprecate the skills we have locally here,
they'll only confuse us."* `lib/scaffold.ts` stops copying
`.claude/skills/vault-search` and `vault-add` into provisioned vaults; the
plugin's HTTP pair takes those names. Both scaffolded skills describe the
pre-lake-refactor vault (`domains/`, `library/`, `inbox/`, a `triage` pass
routing by domain description) and mislead every agent that reads them
today, so this is a bug fix that happens to also remove a name collision.
`setup` and `verify` are engine/config skills and stay.

## Sequencing

- ~~**Claim-code endpoint first** (§6)~~ — **done.** `control/connect.ts`.
  The critical path is unblocked: a token can now be acquired.
- ~~**PR 1 — the plugin** (§1)~~ — **done**, #119. `clients/claude-plugin/`,
  with `test/plugin.test.ts` running the scripts against a live `lib/api.ts`
  on a socket, and a `claude -p` round trip proving all three paths (memory
  injected, a note found, an item landed). Same PR retired the scaffolded
  pair (decision 8).
- ~~**PR 2 — `GET /connect`** (§2)~~ — **done**, #120. `control/install.ts`
  renders `control/install.sh` with the origin baked in and **every plugin
  file embedded as a heredoc**, so the installer is self-contained: one
  fetch, one SHA-256 to publish, nothing to clone. Exact-match GET above the
  `/connect/` prefix branch; the `/connect` → 404 tripwire in
  `control/test/server.test.ts` is updated. Verified by running the real one
  line — `curl … | BB_CODE=… sh` — with `git` absent from `PATH`, into a real
  Claude Code, then asking it what it knows.

  Two things PR 3 needs from it:
  - **The SHA-256 the card publishes is the response `ETag`** — the same
    value as `sha256(await res.text())` on `GET /connect`.
  - **`BB_REPLACE=1`** skips the already-connected prompt. It is the escape
    hatch for the no-tty case (`ssh -T`, CI), where the default is to change
    nothing and leave the code unspent.
- ~~**PR 3 — the agents tab's Connect button** (§4)~~ — **done**, #121.
  The button, the one line, the countdown, the "see what this runs" expander
  with the script's SHA-256, the live flip to connected, and the token list
  with revoke. Two new control routes (`GET /connect/tokens`,
  `POST /connect/revoke`) over `control/tenantTokens.ts`, which reads the
  tenant's own token store on disk — the authority for `last_used` and
  revocation, and a **filesystem** seam because Fork E forbids control from
  value-importing the engine.

  Verified in a browser against the real built viewer: click → code →
  paste the line in a terminal → the card flips itself to connected →
  Revoke → the connected machine's very next call is refused, in the
  plugin's words rather than a raw 401.

**The read side of #45 is now complete.** What remains is capture.
- **Capture-side separately** — #47 needs #46 (arrival envelope) and #48
  (prompt updates). #46 touches the envelope every integration shares; it
  does not belong in the same change as the plugin.

## References

- #45 (this issue; its 2026-08-10 comment carries the dependency picture and
  the read-side/capture-side split), #38 (funnel half after the 2026-08-10
  scope trim), #86, #105
- `docs/plans/2026-08-09-product-shell-v1.md` §4 — the original `/app/connect`
  spec
- `docs/plans/2026-07-24-agent-interop.md` — still-valid core (CLI + files +
  skills ordering); its CLAUDE.md-stanza delivery is superseded by the plugin
- `deploy/HTTP.md` — the tenant API surface the skills call
