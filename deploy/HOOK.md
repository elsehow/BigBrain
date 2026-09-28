# The write-protection hook (user-global)

Interactive Claude Code sessions must be read-only on vault content — the
sanctioned writers are the headless runners (which set `BIGBRAIN_ROLE`) and
the inbox path (`bigbrain drop`). That contract is enforced by a
PreToolUse hook in `~/.claude/settings.json` — user-global because it must
gate every session on the machine regardless of cwd.

**Install it with `bigbrain hook`** — it renders the entry for the
vault it targets (absolute path and role baked in), previews it, and
`--apply` merges it into your settings, backing the old file up first.
`--remove` strips exactly that vault's entry. The rendering and merge
logic live in `lib/hook.ts`; each entry carries a `: bigbrain-guard <root>;`
marker so repeated applies replace rather than duplicate, and your other
hooks are never touched.

Once installed, the entry tracks the engine: `bigbrain install` refreshes
an already-consented entry to the current rendering on every run (never
adds one — first install stays the explicit `--apply` step above).

Semantics:

- `BIGBRAIN_ROLE` set → the headless runner's write key: the record planes
  open (that is the point of it), **except `queue/` and `log/`, which stay
  denied** (#67). The runner moves messages and appends log events with
  in-process calls, never through a model's Bash, so nothing legitimate
  needs the write — they are the audit spines, where a record that
  vanishes untracked breaks "decline is terminal, nothing is silent". A
  command that merely says "queue" still passes: the guard matches
  `queue/` tokens, not words.
- **Interactive sessions**: deny `references/`, `entities/`, `log/`,
  `lake/`, `queue/`, `memory/`, `observations/`, and `.blobs/` — the
  machine-written-only planes (intake code and the sanctioned passes,
  never a model or a hand-edit); inbox writes are legitimate. (`bigbrain
  drop` passes: that command string carries no `<tree>/` token.)

A deny matches either (a) the checkout's absolute path followed by a
guarded tree name anywhere in the tool input, or (b) a bare
`<tree>/` token when the session's cwd is inside the checkout.

Known tradeoff: the hook string-matches command text, so a read-only Bash
command that merely mentions `entities/` (e.g. `git log -- entities/x`) is
also denied — use Read/Grep/Glob for those.

Requires `jq` (`brew install jq`); preflight warns if it's missing.
