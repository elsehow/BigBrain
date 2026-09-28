# Work as a view: the queue is derived, the gardener has one verb

**Decision record — 2026-08-23 (Nick, in session).** Settles the engine's
work model for the `show-hn` launch and after. Supersedes the stored-queue
reading of `docs/design-principles.md` §2 ("all curation flows through the
queue") without changing its intent; §1, §3, §5 and the prompt-injection
posture are unchanged and load-bearing here.

## The sentence

> All inputs are arrivals. All outputs are appended events. The queue is a
> **view** over the logs — never a thing stored. The gardener has one verb.

## Why now

Two decisions on 2026-08-22 made this the moment:

- **Everyone gardens with their own agent.** Hosted bigbrain.cool runs no
  model on a user tenant's content (#494); the user's Claude Code tends the
  vault — locally, or over HTTP for a hosted tenant. The engine therefore
  needs a contract a *remote* agent can pull work through. A directory of
  YAML files on the host's disk is not that contract.
- **The editor pass retires** (#498). The editor was the only consumer of
  the stored queue (`queue/{pending,running,done,failed}/<id>.yaml`,
  `lib/queue.ts`). The two native passes already compute their own work
  from the logs: intake asks "which insertions does no assertion cite yet"
  (`queuedAssertionInsertionIds`, `lib/assertionAgent.ts:417`); memory asks
  "which assertion events lie past my cursor" (`memoryWork`,
  `lib/memory.ts:245`, cursors from `2026-08-21-memory-assertion-inputs.md`).
  They bypassed the queue because the logs already answered the question.
  Naming that — *work is a query over the logs* — is the whole correction.

## The model

### Two logs are truth

`log/insertions/` (every arrival, `lib/insertionLog.ts`) and
`log/assertions/` (every claim, `lib/assertionLog.ts`). Append-only,
git-tracked, host-written through validated boundaries; models propose,
never write. Journals (`journal/*`) record runs. Projections (`.state/`,
`lib/assertionProjection.ts`) are disposable views. Nothing else is written
by the engine except `memory/*.md`, which is itself a pure function of the
logs up to a cursor.

### Work is derived, not enqueued

```
dueWork(vault, kinds?, limit?) → Job[]
```

A pure function over the logs and projections. A job exists because the
logs do not yet satisfy it; `submit` appends events; the job disappears
because the view recomputes. No state transitions, no files to move, no
DLQ directory — a job that keeps failing is a job that keeps being due,
and the journal says why.

Job kinds, now:

| kind | due when | settles by |
|---|---|---|
| `intake` | an insertion no assertion cites (today's `queuedAssertionInsertionIds`) | assertions citing it, or a decline event citing it |
| `memory` | assertion events past the memory cursor (today's `memoryWork`) | a memory run journaled with the new cursor |

Job kinds, later — each is one more arm of the same function, not a new
producer bolted onto a queue:

| kind | due when | ticket |
|---|---|---|
| `voice` | a directive/request/observation insertion no assertion acknowledges | this plan (voice as arrivals) |
| `materialize` | the retrieval ledger shows a miss / expensive assemble | #326 |
| `refresh` | staleness × demand says a synthesis is cold and hot | #325 |
| `synthesize` | a standing order is due and unsettled | #53 |

### Declines are events

A gardener that judges an item unworthy appends a decline event citing the
job (the shape #10 wanted as a verdict ledger). The job is then settled,
not retried forever; the reason is durable; replay reproduces it. The
existing run/rejection journal's handled-insertion dedup is the same idea
and folds into this.

### One verb

The gardener API is three tools and one prompt:

```
next(kinds?, limit?)  → [{ lease, job, inputs }]      # lease = ephemeral claim with TTL
submit(lease, events) → { appended, rejected[] }      # host-validated, idempotent
read tools            → search / note / memory / entity (the existing /v1 verbs)
```

- `inputs` is the context pack the runner would otherwise go and fetch: for
  `intake`, the insertion(s) and the projection neighborhood; for `memory`,
  the assertion-delta blocks and cursors (#459's rendering).
- `submit` runs **the same validator** the pi loop's `submit` tool runs
  today (`lib/assertionPiCall.ts` → `lib/assertionAgent.ts`); idempotent by
  insertion id / lease id.
- Leases are ephemeral — `.state/` locally (today's `assertion.lock` shape,
  `lib/assertionAgent.ts:46`), host memory/SQLite for the door — with a TTL;
  single-flight per tenant; an expired lease is re-offered. Leases are never
  truth; losing them loses nothing.
- **Two backings, one contract.** The BigBrain MCP server (#87) serves these
  tools in *mirror mode* (vault on the same disk — self-host, and the hosted
  operator's own tenants on the box) and in *thin mode* (token → host HTTP,
  #479 — a hosted user's own machine). The Claude Code plugin's
  `/bigbrain:tend` (#480) is the prompt that drives them; `claude -p
  /bigbrain:tend` is the one runner (#514).

### The warden is one job

`control/warden.ts` stops being `editor | memory | assertion` with job keys,
journal subdirs and three timers. It is: *for each operator tenant (#499),
run the gardener.* The self-host install renders one launchd/systemd unit.
The plugin ships one skill. A hosted user's laptop runs the same skill over
thin mode. `journal/queue`, `journal/assertions`, `journal/memory` remain
as history; new runs journal under one name.

### User voice is arrivals

A directive (the note typed beside a clip), a request ("merge these two
entities"), an observation (the agent's `--why`), a standing order — each is
an **insertion** with a `kind`, in the same log, under the same
sender-identity rules (person verbatim, agent framed). "Due" for voice is
"no assertion acknowledges it yet." The memory pass reads the user's voice
from its log cursor exactly as it reads everything else. This retires
`queue/`, `requests/done/`, `observations/{pending,done}` and the
`emitArrival / emitRepair / emitDirective` emitters (`lib/queue.ts`) —
arrivals already have a validated door.

Free text remains **data, never instructions** (design-principles §2): a
directive is rendered to the gardener as quoted user guidance attached to a
job, exactly as `lib/editor/prompt.ts` renders guidance today. The grade of
what an emitter may say is still enforced by signature — now the insertion
envelope's `from_kind`, not a queue emitter.

## What this deletes

On top of the cruft already filed (#505–#512, #496, #497):

- `queue/<state>/*.yaml`, the runner's atomic-rename machinery and DLQ
  (`lib/queue.ts` state handling; `inbox/unsorted` as the DLQ tree).
- `requests/`, `observations/{pending,done}`, `bin/observe.ts`'s spool
  semantics (the verb can stay as "drop an observation").
- `WardenPass`, `WARDEN_PASSES`, `PASS_SUBDIR`, the per-pass timers and job
  keys; the `bin/assertion.ts` / `bin/assertion-agent.ts` duplication.
- The legacy queue view (`/api/queue`, `lib/queueFeed.ts`, `QueueTable`'s
  shape) → replaced by the **due-work view**, which is also #494's "N items
  waiting for your agent" and the launch-day empty state.

## What this adds

- `lib/work.ts`: `dueWork()` — the two existing due-checks behind one
  interface — plus leases and the `next`/`submit` contract. Small.
- `kind` values for voice arrivals in the envelope; an acknowledgment
  convention (an assertion citing the voice insertion).
- A decline event type in the assertion log.

## Invariants preserved

- **§1 pure derived view.** Delete every projection, lease and memory file;
  replay the two logs; everything — including the queue — comes back.
- **§3 integrations deliver the discussable version.** Unchanged; a voice
  arrival is an envelope like any other.
- **§5 no migrations.** Old `queue/`, `requests/`, `observations/` trees
  are frozen history, tolerant-read; new vaults never get them. `journal/*`
  names stay.
- **Prompt injection.** Jobs are typed; `inputs` are data; the runner's
  tool surface is the MCP server only (no Bash, no file tools — #514
  reproduces the pi loop's containment).
- **No inference on the host for user tenants** (#494). `dueWork` is CPU
  over SQLite; the gardener is the user's agent.

## Sequencing against the launch

1. `lib/work.ts` with `intake` + `memory`, leases, `next`/`submit` — the
   contract #87 (mirror) and #479 (thin) expose and #514 drives. This is
   *less* work than wiring three passes into the MCP server.
2. Warden = one job (#514), gated by #499.
3. Voice as arrivals — forced by #498: when the editor goes, `queue/done`
   stops being where the memory pass finds the user's voice. Directives
   first; observations and requests with it if cheap.
4. Later kinds (`materialize`, `refresh`, `synthesize`) and declines when
   their tickets come due — each is one arm in `dueWork`.

## Open questions

- **Lease authority across gardeners.** A hosted tenant may be tended from
  a laptop (thin) and, if the operator flag is set, from the box (mirror).
  The door's lease table must be the authority for that tenant; mirror mode
  on the box should take leases through the same table. Decide in #479.
- **Memory's settlement record.** Today a run writes `.state/memory.json`'s
  cursors (ephemeral). Prefer journaling the cursor in `journal/memory/*`
  (a log) so `dueWork` never depends on `.state/`.
- **Acknowledgment semantics for voice.** "An assertion cites it" is the
  simplest; a standing order needs "settled for this period." Settle when
  #53 lands.
- **Naming.** `tend` for the verb, `due` for the view — or the queue word
  kept for continuity in the UI. The UI says "waiting for your agent".
