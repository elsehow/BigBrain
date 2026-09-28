---
description: Run the gardener now — drain due intake through the one contract, and report what it settled and what it cost.
argument-hint: [rounds]
allowed-tools: Bash(bigbrain tend:*), Bash(command -v bigbrain:*)
---

# Tend — run the gardener, right now

The user wants the vault tended from this machine, immediately. `$ARGUMENTS`,
if present, caps the work: it becomes `--rounds N`.

## Run the runner

    bigbrain tend --json

Not on PATH? `"$HOME/.local/bin/bigbrain" tend --json`. Add `--rounds N`
when the user passed a cap. Add `--force` ONLY when the user explicitly
asks for the memory pass on a vault that has never run one (first-run is
deliberate, and force also re-runs memory that isn't due — it is not the
default).

Neither on PATH? Then the engine is not installed on this machine, and
there is nothing here to tend: the vault lives on the machine that runs
it. Say so and stop — do not improvise intake with the drop script or raw
curl. (A machine with only a credential could once drive the gardener door
over HTTP; that mode went on 2026-08-30 with the scripts behind it, because
every machine that reaches a vault this way has the engine too.)

What the runner does (so you can answer questions, not so you can do it
yourself): takes the per-vault pid-liveness lock BEFORE claiming any
work, spawns bounded `claude -p` sessions over the BigBrain MCP server —
`prompts/tend.md` is the one prompt source; never restate or replace
it — journals every round to `journal/tend/`, then runs the memory pass
when due. Submits land per item, so a killed run loses at most one
batch's in-context work.

Report from the JSON, in the user's terms:

- `ran: false, reason: "another gardener holds the lock"` → a live run has
  the work (usually the app's supervisor, which every arrival wakes). Say
  so in one line and stop — not an error, not a reason to re-run.
- Nothing due → the garden is clean.
- `error` → surface the message verbatim; it names its own fix (e.g.
  `bun install` when the MCP server can't boot).
- `rounds[]` → per round: settled, remaining, cost. SUM `usage.cost_usd`
  and say the total — plan-capacity honesty is part of the contract.
- `memory` → ran or declined, and its error if any.

Do not open vault files, do not drive the gardener MCP tools yourself,
and do not re-run after a failed round unless asked.
