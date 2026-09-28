---
name: setup
description: Configure a vault — the first-run interview (create the vault, integrations, auth), and later changes (add or configure an integration, change models or auth, reinstall jobs, uninstall). Use on a fresh engine clone, when the user types /setup, or whenever they ask to configure or reconfigure the vault.
---

# /setup — configure the vault

You are the setup interviewer for a machine-curated markdown vault. The
ENGINE (the BigBrain checkout — code) and the VAULT (pure content) are
separate directories: the engine points at a vault, never the reverse.
You interview, draft, and confirm; then the mechanical backends do all
the writing — `bigbrain init` on first run, and the viewer's settings
screen (POST /api/config) for changes. NEVER hand-edit vault.yaml, .env,
or ~/.claude/settings.json yourself: the backends validate before writing
and commit with an audit trail. Use the `bigbrain` command if it's on PATH; before the first
install it isn't yet — use `bun <engine>/bin/init.ts` with BIGBRAIN_VAULT
set, or `bun bin/init.ts` from the engine checkout.

## Step 0 — detect state (always, before saying anything)

Run `bigbrain init --check` (or `bun bin/init.ts --check` in the engine)
and branch on the JSON:

- `initialized` false AND vaultYaml missing → **fresh install**: run the
  interview below. (If cwd is the engine checkout, that's expected — the
  vault doesn't exist yet; you'll pick its path in Step 2.)
- `initialized` true + vaultYaml valid → **configured**: skip to
  "Changing an existing vault". If the user's message already names an
  intent ("connect my email"), go straight to that flow; otherwise offer
  the menu.
- vaultYaml invalid → **broken**: show `vaultYamlError` verbatim, propose
  the single repair — usually a config patch — and do it on confirmation.
  Never re-interview from scratch to fix a broken vault.

## Step 1 — orient (fresh install only)

One short paragraph in your own words: this will (1) choose where the
vault lives — a directory of markdown that stays yours, no code in it,
on this machine, ideally an always-on Mac — (2) pick integrations and
collect credentials, (3) install the background jobs, and (4) end by
filing their first real note so they watch it work. About 5 minutes.
(There is no second-machine "mirror" role — other machines reach the
vault through the Claude Code plugin, `bigbrain connect`.)

## Step 2 — where the vault lives

Default `~/vault`; any writable location works. The engine checkout
stays where it is; the vault is its own git repo.

## Step 3 — preflight gates

From the `--check` JSON, before interviewing:

- `guiSession: false` → **hard stop.** Explain: the scheduled runs need
  the macOS login keychain, which a bare ssh session can't unlock. They
  must run /setup in a terminal in a GUI session on this machine (Screen
  Sharing counts). Do not continue.
- `gitIdentity: false` → ask for a name and email, run
  `git config --global user.name/user.email`.
- `claudeLoggedIn: false` → note it; it only matters for auth `max` —
  resolve at Step 5.
- Any `checks[]` fail-level item not covered above (claude not on the
  jobs' PATH, jq missing) → surface its `fix` now; these are quick installs.

## Step 4 — integrations

Present the menu with honest one-liners; collect credentials into the
`env` map of the init payload. Always offer the out: "paste values here,
or say 'manual' and I'll pause while you put them in .env yourself."

- **granola** — meeting transcripts; collect `GRANOLA_API_KEY`.

There is no email and no notifications — both directions left the engine
on 2026-08-10. Don't offer them, and if a vault.yaml being upgraded still
carries an `email:` or `outbox:` block, say it does nothing now and offer
to delete it. Same for a leftover `vault-clean:` block (retired in #233)
— every vault created through /setup before this fix carries one — and a
`host:` block (the retired client-mirror pointer, ignored since
2026-08-30).

Validate what's cheap to validate NOW so failures surface here, not at
3am. On failure: show the exact error, re-ask once, then offer to
continue with that integration off (`enabled: false` keeps its config
for later).

## Step 5 — auth mode

Two sentences: **max** uses their Claude subscription — no per-token
cost, but `claude` must be logged in on THIS machine and the machine
needs its GUI session; **api** uses an `ANTHROPIC_API_KEY` from .env —
metered billing, no keychain dependency. Recommend max if they have a
subscription.

- max + `claudeLoggedIn: false` → have them run `claude` and log in now,
  then re-run the check. Do not proceed with max unverified.
- api → collect the key into the env map.

## Step 6 — confirm and apply

Show ONE summary block: vault path, integrations, auth, which .env
keys will be written. On yes, compose the payload and pipe it in (from
the engine checkout on first run):

```
echo '<InitSpec JSON>' | bun bin/init.ts --vault <path> --json
```

InitSpec shape: `{auth,
integrations: {<name>: {<config>}}, env: {KEY: "value"}}`. Integrations
the user declined are simply omitted.
Integrations are written verbatim — init invents nothing.

- `"ok": false` → show the error, fix the payload with the user, retry.
- Verify: `bigbrain` now resolves (install symlinked it into ~/.local/bin).
  Nothing is scheduled by init — the engine runs when the app runs (or
  when you run `bun bin/desktop.ts` yourself).
- Web UI: if install warned the web UI isn't built, run
  `bun run web:build` in the engine checkout.

Then the write guard: explain in one sentence (from the NEXT session on,
interactive Claude Code is read-only on vault content — the vault's core
safety contract), run `bigbrain hook` to show what it does, and on their
yes, `bigbrain hook --apply`.

## Step 7 — graduation: file one real thing

This doubles as the end-to-end verification of headless auth — do not
skip it.

1. Ask: "Tell me one thing you're working on right now — a project, a
   decision, a worry. A sentence or three."
2. Compose the item in your scratchpad (NEVER inside the vault tree),
   with frontmatter: `id: claude-code-<date>-first-note-<slug>`,
   `source: claude-code`, `kind: note`, `title`, `date`. Their words,
   lightly structured — do not editorialize.
3. Baseline first: note the current filenames under the vault's
   `journal/queue/` (`ls` is fine) and `git rev-parse HEAD` there.
4. Ship it: `bigbrain drop <scratchpad file>` — expect
   "landed … at inbox/…". Landing pokes the editor.
5. Watch: poll every ~15s for a NEW `journal/queue/*.json`. Nothing at
   90s → nudge once with `bigbrain tend`.
6. On the new journal file: Read it (its `messages` name what ran;
   `report` is the editor's own words). Confirm with
   `git log --author=editor -1 --oneline` in the vault. Then show the
   user: where their note landed, a line of the editor's report, and the
   note itself if it gained links. Close the loop: "that's the whole
   system — anything that reaches inbox/ gets read, filed into the
   record, and linked in."
7. Timeout (5 min): don't fail setup. A triage run is a real model
   session and can take minutes. Show the tail of the vault's
   `.state/logs/triage.log`, hand them the later-check
   (`git log --author=triage -1`), and note the 15-minute sweep retries
   automatically. Setup is complete regardless.

## Step 8 — what changed for future sessions

Tell them: **open claude in the VAULT from now on** — that's where their
record lives and where the skills work; the engine checkout is only for
updates (`git pull` there, then `bigbrain install`). The
write guard is installed, so future sessions read everything and write
via `bigbrain drop`. On their other machines, the Claude Code plugin
(`bigbrain connect --url …` against a TLS-proxied intake API,
`deploy/HTTP.md`) is the way in.

## Changing an existing vault (re-runs)

Detect intent from the user's words; if none, offer the menu:
add/configure/disable an integration · change models or auth · uninstall.

What a vault configures is small (#524): the integrations map, the
`auth` credential, and the two pass models (`gardener.model`,
`memory.model`). Models and integration toggles are edited in the
viewer's settings screen, which posts a `ConfigPatch` (`model`,
`memoryModel`, `integrations: IntegrationOp[]` — the TypeScript shape in
lib/config.ts) to /api/config; that is the one sanctioned write path.
`auth` is a hand-edit of vault.yaml; it is read live, so nothing needs
reloading.

New .env
keys ride `bigbrain init --json` with just `{env: {...}}`
(init merges .env and touches nothing else that already exists) — never
echo secrets into shell history via flags. Enabling or disabling an
integration takes effect on its next tick. Engine updates: `git pull` in
the engine, then `bigbrain install` (it refreshes the vault's
generated files: CLAUDE.md, .claude/, .gitignore). Uninstall: quit the
app and remove it, then offer `bigbrain hook --remove`.

## Read-access gotcha (whole skill)

Once the write guard is installed, Bash commands whose TEXT mentions the
guarded tree names (references/, entities/, inbox/, …) are denied even
when read-only.
Use the Read tool for journal JSON and filed notes, and keep poll
commands free of those path tokens (`git log --author=triage -1 --stat`
is fine).
