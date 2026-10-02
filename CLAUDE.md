# BigBrain — the engine

This checkout is the ENGINE: the code that runs a machine-curated
markdown vault. **Vaults live elsewhere** — a vault is a separate,
code-free git repo of pure content, and this engine points at one
(via `BIGBRAIN_VAULT`, the nearest `vault.yaml` above cwd, or
`~/.config/bigbrain/vault`). If no vault exists yet, offer **/setup** —
a ~10 minute interview that creates one.

Day-to-day work with a vault happens *in the vault* (open Claude Code
there; its CLAUDE.md carries the contract). This checkout is for two
things only:

- **Updates**: `git pull`, then `bigbrain install` — it refreshes
  the vault's generated files (CLAUDE.md, .claude/, .gitignore),
  points `~/.local/bin/bigbrain` at this checkout, and rebuilds
  nothing silently (it warns if `web/ui/dist` is stale — `bun run
  web:build`). `docs/self-host.md` is the runbook.
- **Development**: the system's own code. `bun install` first. The
  /verify skill explains sandboxing against a scratch vault — never
  develop against a real one.

## Public development history

This is the active public development repository. Read CONTRIBUTING.md. Never
merge or push branches/tags from the archived private history. Port reviewed
patches onto public main instead. Historical issue references may not resolve
in this fresh repository.

## One session, one worktree

**Never work in the shared checkout's working tree.** Several Claude
sessions run against `~/Projects/BigBrain` at once, and they cannot see
each other: a `git checkout` or `git reset --hard` in one silently
destroys another's uncommitted edits, and a `git add -A` sweeps a
stranger's half-finished change into an unrelated commit. Both have
already happened — #167 carried a stray deletion of `GearMenu.svelte`
into a control-plane commit and broke `main`'s viewer build (#168
restored it), and a reset the same day erased a finished UI change that
had to be written twice.

So, on any task that edits files:

```
git worktree add -b <branch> .claude/worktrees/<branch> origin/main
```

Work there, commit early (a commit survives someone else's reset — a
dirty tree does not), then push and open a PR from that worktree.
`bun install` once in the new worktree, and again in `web/ui` if you're
touching the viewer. `git worktree remove` when the PR is merged.

Leave `~/Projects/BigBrain` itself parked on `main` as everyone's
read-only reference.

## Tickets and design principles

Design/engineering work items are tracked as **GitHub Issues on
`elsehow/BigBrain`** — use `gh issue list/create/view` from this
checkout. File an issue when a discussion surfaces work that isn't
being done now; don't let it live only in a conversation.
`docs/design-principles.md` holds the architectural principles
(everything but the logs is disposable; work is a view, not a queue;
integrations deliver the discussable version; the engine sorts but
never answers — BYO model; user vaults are never migrated) — read it
before designing anything that touches ingestion or curation.

## There are no hosts

BigBrain is self-hosted: one vault per machine, and **the desktop app
is the install** (`docs/self-host.md`), reached from other machines
through the Claude Code plugin over the intake API. Two retirements got
it there: the `--role client` mirror — a second checkout that pulled the
vault over ssh and shipped its writes to the host — on 2026-08-30, and
the `--role host` CLI install itself on 2026-08-31 (#645), which took
`lib/scheduler.ts`, `deploy/host*` and every launchd/systemd template
with it. `bin/desktop.ts` is the one supervisor; there is no `--role`
anywhere any more. **No vault or engine code deploys anywhere. App assets publish only to
`/srv/releases` with `bun run site:deploy` (`site/README.md`). The homepage
belongs to `elsehow/bigbrain.cool` and `/srv/website`; never publish to the
retired `/srv/site` or upload this repo over the website.**

**The one exception is the shared-vault server** (`bin/shared.ts serve`). A
shared vault is several people's, so it has to run somewhere they can all
reach: its operator compiles `bin/shared.ts` (`bun build --compile`) and runs
it as a service on a machine of their own, one vault per server, behind TLS
(`deploy/shared-vault/`, `docs/shared-vault-connector.md`). That is an
operator's deployment of one vault, not a BigBrain host: nothing here deploys
it, and no other engine code runs there.

The multi-tenant hosted product — the `control/` control plane,
`bigbrain.cool` / `staging.bigbrain.cool`, per-tenant systemd units,
`deploy.sh` / `bootstrap.sh`, the `bb-*` operator shims — was retired
on 2026-08-26 (#566). The last commit that carried it is tagged
**`hosted-multitenant-final`**; read it there, and never resurrect it
in place. If a memory, a doc under `docs/plans/`, or a `~/.ssh/config`
alias tells you to ship code to a host, it predates the retirement:
there is no deploy target, and an agent hunting for one is already off
the path.

**The namespace is `bigbrain`, everywhere:** `BIGBRAIN_*` env vars,
`~/.config/bigbrain/` (secrets, token stores, the vault pointer), the
`bigbrain-guard` hook marker. The engine was born as `s-tier`; the
rename landed 2026-08-27 (#582) and the one-release tolerance for the old
names ended 2026-09-03 (#522). Nothing in the code spells the old name
now, and nothing may: there is no install on the old side of that day.
`lib/legacy.ts` holds the other retired install (`~/.bigbrain/plugin/`,
#693) and nothing else.

## Private data stays out of the engine

All committed tests, UI scenes, examples, and code comments use invented data.
Never copy vault excerpts, task prompts, model summaries, source filenames,
entity IDs, contact details, or personal relationship descriptions into this repo.
Private profiling artifacts stay outside the checkout; publish aggregate metrics
only. See `docs/development-data.md` for fixture and history-cleanup boundaries.

## Looking at UI without a vault

`bun run web:dev` then open **`/dev.html`** — the workbench. It mounts a
component against fabricated state, with a scene picker, a width slider
and a dark toggle. No vault, no server, no queue.

The scenes live in `web/ui/src/dev/fixtures.ts` and are shared with
`test/queueView.test.ts`, so a state you can LOOK at is the same state the
tests assert on. Add a component by giving it scenes there and one entry
in `Workbench.svelte`. Nothing under `src/dev/` is reachable from
`index.html`, so none of it enters the shipped bundle.

A scene rides the query string (`?c=LinkGraph&s=weighted`), so a state can
be linked to and screenshotted headlessly. Two more parameters for the
graph: `?t=skin-dusk` wears one of this machine's skins (the dev proxy
reaches the live engine's `/api/themes`), and `?g=/some.json` draws a graph
of your own — a vault's `/api/graph` saved under `web/ui/public/` (never
committed) — in place of the fabricated scene, which is the only way to
judge the canvas at the size of a real vault.

Reach for it whenever the question is visual or geometric, and MEASURE
rather than squint — `getComputedStyle` in the browser is what caught an
18px grid column silently rendering 11.5px. Scenes should skew toward
what a live vault won't produce on demand: failures, absurd label
lengths, both passes running at once.

## Linting

`bun run lint` (oxlint) — fast, and expected to be SILENT. If it warns,
fix it or record why with `// oxlint-disable-next-line <rule>` on the
line immediately above the code (a directive followed by more comment
lines does nothing — "next line" is literal).

**It names the source directories explicitly**, and must keep doing so.
A bare `oxlint` walks the whole tree — including `.claude/worktrees/`,
where every other session's checkout lives. Those are full checkouts
carrying their own `.oxlintrc.json`, so oxlint uses the NEAREST config
and the root's `ignorePatterns` never reach them: you get a stranger's
half-finished branch reported as your own warnings, and no ignore rule
here can suppress it. Add a directory to the script when you add one to
the repo.

**It does not read `.svelte` files, deliberately.** oxlint has no model
of Svelte semantics, and its confident-looking findings there are wrong
in ways that would break things if obeyed: `let el: HTMLDivElement`
looks unassigned when it's a `bind:this` target, and the runes idiom
`$effect(() => { app.rev; void load(); })` looks like a useless
expression when that bare reference IS the dependency registration.
Deleting it would silently kill live updates. Svelte files are
`svelte-check`'s job — it's Svelte-aware and already clean.

Two linters, each only where it is competent. Keep it that way.

## Layout

- `bin/` — entry points; `bin/cli.ts` is the `bigbrain` command
  (symlinked to ~/.local/bin/bigbrain by install)
- `lib/` — shared code; `lib/engine.ts` owns the engine/vault split
  (ENGINE_ROOT vs the discovery mechanisms). Two config surfaces, one
  reader each: `lib/manifest.ts` for `vault.yaml` and `lib/env.ts` for
  the environment — both side-effect-free, both taking `root` rather
  than reaching for it. `lib/vaultRoot.ts` is the ONE module that
  resolves a vault at import, and only entry points (`bin/`,
  `integrations/*/run.ts`, `web/server.ts`) may import it.
  The five append-only logs — assertions, insertions, declines,
  revocations, entity aliases — are ONE machine, `lib/eventLog.ts`;
  a `*Log.ts` module is its event type, its validator and its create
  function, and nothing else. A sixth event kind adds a file, not a
  sixth copy of the month-walk and the collision check. Id patterns
  and the entity-label normalization live once in `lib/ids.ts`,
  sha256 once in `lib/hash.ts`
- `integrations/` — inbound/outbound integrations, each ticked by the
  supervisor on its `CADENCE` interval (`lib/desktopSchedule.ts`)
- `web/` — the read-only web viewer (:4747)
- `bin/shared.ts` + `lib/shared*.ts` — the SHARED vault door (:4749,
  `docs/shared-vault.md`): one vault several authenticated members write
  to, named explicitly by `--vault` and never discovered. `--public-url`
  opts it into a read-only Claude connector (OAuth + `/mcp`,
  `docs/shared-vault-connector.md`)
- `desktop/` — the Tauri app: a shell around the same engine
  (`desktop/README.md`)
- `test/` — the bun test suite; fixtures and helpers under `test/support/`
- `brand/` — SHIPPED brand assets (not `docs/design/`, which holds
  sources): `brand/email/` is the mail lockups + templates, served
  public and immutable at `bigbrain.cool/email/*.png` — by the retired
  control plane once, by `site/` now (bigbrain.cool points at the static
  site). The filenames stay reserved — sent mail hotlinks them; never
  rename or re-cut one, add a new filename. `brand/README.md` has the rules.
  **An optional animation of the mark** lives in `web/ui/src/lib/logomark.ts`. It
  models the cube and its turning layers in the theme's three colours,
  `Logomark.svelte` draws it, and video of it moving — for CapCut, any
  theme, with or without the wordmark — is cut with `bun run
  logomark:render` (`brand/README.md`, "The mark, moving"). Look at it
  in the workbench: `/dev.html?c=logomark`. The shipped SVG and icons
  remain unchanged.
- `site/` — the static site (`bun run site:build` → `site/dist/`): the
  extension downloads page at `/plugins/` with the builds cut from
  `clients/browser-extension/`, and `/email/*.png`. `site/README.md` has
  the nginx config and where it is served from today.
- `deploy/` — `deploy/vault-template/` (the generated vault files) and
  the API/auth/hook notes; the launchd + systemd templates that gave the
  directory its name retired with #645
- `prompts/` — the passes' prompt templates, versioned with the engine
  and read ONLY from here. #524 stopped seeding them into vaults;
  2026-08-31 took the vault's precedence too and made `bigbrain install`
  shed the copies an older vault still held, because a vault's stale copy
  had been winning over every engine fix
- `vault.example.yaml`, `.env.example` — seeds for `bigbrain init`
