# The shared vault — one record, several authenticated members

*The design. To run one on a server, follow the runbook,
[deploy/shared-vault/README.md](../deploy/shared-vault/README.md). A separate [local owner UI](shared-vault-v0.md) is also available. `bin/shared.ts`, `lib/sharedMembers.ts`,
`lib/sharedVault.ts`, `lib/sharedVaultApi.ts`. Nothing here deploys itself. Governing principles:
[design-principles.md](design-principles.md) §1 and §2.*

A shared vault is **one authoritative BigBrain vault directory** whose
append-only logs are written by several people rather than by one machine
account and its gardener. It reuses the engine's record as it is —
`log/insertions/` for evidence, `log/assertions/` for claims,
`log/revocations/` for corrections — and adds one durable log of its own,
the change feed. There is no mandatory central gardener: **write permission
is the permission to assert**, attributably, with citations, and every
member may do so. What is added over the personal vault is *who* and *by
what authority*:

| Question | Answer, and where it is recorded |
|---|---|
| Who is asking? | A **member** (`lib/sharedMembers.ts`): a stable, immutable, never-reused handle with `read`/`write` permissions, one of whom is the **owner**. Derived from the bearer credential on every request, never from the body. |
| Through what? | A **credential** `sv_<id>_<secret>` — a person's device or an **agent** acting as the member's delegate. Its scopes can only be a subset of the member's permissions; the effective set is the intersection, recomputed per request. Only sha256(secret) is stored, outside the vault. |
| Who wrote this event? | `author` on every event: `{kind: "user", id: <handle>}` from a person credential, `{kind: "agent", id: <handle>}` from an agent credential. Neither can produce the other. |
| Whose words is this evidence? | `envelope.origin.author`, **claimed** by the submitter (a forwarded mail's sender, a colleague's note), `author_verified: true` only when a *person* credential submits its own words. Distinct from `envelope.submitted_by` (verified) and `submitted_via` (the credential). |
| Which source is this? | `source_id` — `origin:<id>` when the submitter names a stable origin identity, else a content hash — so the same source resubmitted or corrected by anyone is recognisably the same source. |
| What corrected it, and who? | A **correction** is the author's new assertion (`supersedes`) plus the author's revocation pointing at it; a **retraction** is the author's revocation alone. Only the author — the owner included — can do either. **Moderation** is the owner's revocation under its own procedure (`shared-vault/moderation`), attributed to the owner, leaving the author's text and authorship untouched. |
| What happened, in order? | `log/shared-feed/feed.ndjson`: one line per event landed, with a sequence number, the receive time and the credential — the two things the events deliberately do not carry. A client resumes from `?after=<seq>`. |

Connect, import and outbound contribution stay three different things: a
member *connects* to the shared vault with a credential (this document);
*importing* the shared record into a personal vault is not done here and
would go through that vault's own intake; and *contributing* evidence into
the shared vault is an explicit `POST /v1/evidence` by a member, never a
side effect of reading it.

## Running it

Everything is explicit. The shared vault is named by `--vault` (or
`BIGBRAIN_SHARED_VAULT`) and **never discovered** — not the cwd walk-up,
not the pointer file — because serving a vault to other people should not
happen by accident. `serve` and `inspect` further refuse any vault whose
`vault.yaml` does not say `shared: true`, which only `bigbrain shared init`
writes, so a personal vault cannot be put on this door. The member store
must live outside the vault (default `~/.config/bigbrain/shared-members/<hash>.json`,
mode 0600).

```
bigbrain shared init --vault /srv/team-vault --owner nick             # prints the owner credential ONCE
bigbrain shared member add alice --display "Alice" --permissions read,write --vault /srv/team-vault
bigbrain shared credential mint alice --name "laptop" --vault /srv/team-vault
bigbrain shared credential mint alice --name "assistant" --kind agent --scopes read --vault /srv/team-vault
bigbrain shared member set alice --permissions read --vault /srv/team-vault   # narrows every credential she holds, now
bigbrain shared member revoke bob --vault /srv/team-vault                     # bob's next request is 401
bigbrain shared inspect --vault /srv/team-vault                               # counts, feed head, feed drift
bigbrain shared serve --vault /srv/team-vault                                 # 127.0.0.1:4749 (BIGBRAIN_SHARED_PORT)
```

Member management is CLI-only on purpose: possession of the host account
is the root of trust, as for `bigbrain auth`, and a leaked owner
credential therefore cannot mint or revoke anything. The server never
**writes** the member store either — the CLI is its one writer, and the
door records `last_used` in a sidecar (`<store>.usage.json`, 0600) so a
server's stamp can never race an operator's revoke and write the
un-revoked member back.

One self-service exception (`POST /v1/credentials/agent`): a person
credential with write access may mint an agent credential for its own
handle, so a member's app publishes its gardener's claims as their
delegate rather than in their own voice. The agent records the credential
that minted it (`minted_by`) and stands only while that one does, so
revoking a leaked credential also retires every delegate it minted.

### The door

Bearer-only. Every path — real or not — answers 401 without a live
credential; there is no health probe and no unauthenticated read. 403
names the missing permission. Bodies are `application/json`. The one
exception is opt-in: an operator who sets a public URL turns on the
[Claude connector](shared-vault-connector.md), whose OAuth discovery,
registration, sign-in and token paths answer without a credential, and
whose read-only `/mcp` answers a stranger with a 401 naming where to sign in.

| Route | Needs | Does |
|---|---|---|
| `GET /v1/whoami` | member | the verified actor |
| `POST /v1/evidence` | write | `{title, body, origin?: {id?, author?, kind?, url?, date?}}` → `{id, source_id, deduped, seq, origin}` |
| `GET /v1/evidence?limit&cursor` · `GET /v1/evidence/:id` | read | evidence, paged / one event |
| `POST /v1/assertions` | write | `{text, sources: [ins_…], confidence?}` → `{id, deduped, seq, author}`; `[[Label]]` links canonicalize to derived entity ids |
| `GET /v1/assertions?limit&cursor&include_revoked` · `GET /v1/assertions/:id` | read | assertions with `revocation` and `resolved_id` |
| `POST /v1/assertions/:id/correct` | write, **author** | `{text, sources, confidence?, reason?}` → new assertion + revocation |
| `POST /v1/assertions/:id/retract` | write, **author** | `{reason}` → revocation |
| `POST /v1/moderation` | write, **owner** | `{assertion_id, reason}` → revocation attributed to the owner |
| `GET /v1/search?q&limit` | read | term-AND hits over evidence and live assertions |
| `GET /v1/feed?after&limit` | read | `{entries, next_cursor, has_more, head}`, ≤200 per page |
| `POST /v1/credentials/agent` | write, **person** | `{token, credential}` — an agent credential for the caller's own handle, returned once |
| `POST /v1/members` | write, **owner person** | `{name, email, permission}` → a member who signs in to the connector by email |
| `POST /v1/members/:id/email` | write, **owner person** | `{email}` or `{email: null}` — set, change or clear; any change unbinds the member's sign-in |
| `POST /mcp` | read | the read-only MCP server — only with the connector on ([shared-vault-connector.md](shared-vault-connector.md)) |

Refusals a client will meet, by design:

- **Forged authorship** (400): a body carrying `author`, `actor`,
  `submitted_by`, `on_behalf_of`, `member`, `credential`, `id`,
  `created_at`, `produced_by`, `supersedes`, `entities`, `author_verified`
  … is refused outright rather than silently overridden. `origin.author`
  and `origin.id` are the one place a name may be supplied, and they are
  stored as *claims*.
- **Invalid citations** (400): `sources` must be 1–20 well-formed insertion
  ids that exist in this vault. Ids are validated by pattern before
  anything touches the filesystem, so `/v1/evidence/../x` is a 400 that
  never became a path; a well-formed id that does not exist is 404.
- **Cross-member correction** (403), **non-owner moderation** (403),
  **already revoked** (409, naming the revocation and what stands).
- Writes are rate-limited per credential (60/min); evidence bodies are
  capped at 1 MiB.
- **Revoked mid-request** (401): the credential is verified before the
  body is read (a stranger's upload is never read) and again after it
  has arrived, so a member revoked or narrowed while their request body
  was still uploading has that request refused, not landed.

### Idempotency and the feed

Events are deterministic: evidence carries no receive timestamp and is
byte-identical on retry; assertion and revocation ids exclude
`created_at`. An identical retried submission, correction, or retraction answers `deduped: true` with the
**original** entry's `seq`, and writes nothing. New writes first prepare a durable journal in `.spool/shared-write.json`;
server startup completes any interrupted write, retaining actor and receive time.
Corrections prepare their assertion and revocation together. Older prototype
writes without a journal still heal missing feed entries on retry, and
`bigbrain shared inspect` reports `feed_missing` until repaired. A torn last line (a crash mid-append) is not part of the feed, and
the next append starts a fresh line after it.

The feed is a log, not a cache: it carries what the events do not
(receive time, credential), so it is retained and backed up with them,
not rebuilt. One writer process per vault (`serve` takes a lock under
`.state/`); a hand-run CLI beside a running server is not a supported
write path.

## Remote transport

The door speaks plaintext HTTP and bearer secrets ride in it. By default it
binds `127.0.0.1`; `--host` off loopback is refused unless `--remote` is
passed, and `--remote` is the operator's statement that **TLS terminates in
front of it**. The supported shapes are the ones `deploy/HTTP.md` already
describes for the intake API:

- an `ssh -L 4749:127.0.0.1:4749 host` tunnel or a private network
  (Tailscale) for a handful of members — no `--remote` needed, the door
  stays on loopback;
- a TLS reverse proxy (`deploy/Caddyfile.example`, adding a site block that
  proxies to `127.0.0.1:4749`) when members reach it over the internet —
  still bound to loopback, the proxy is what is reachable.

Never publish `:4749` directly, never put the web viewer (`:4747`) in front
of a shared vault, and never point the desktop app's `BIGBRAIN_VAULT` at the
shared directory — the viewer has one operator and would show the whole
record to whoever holds its session on that machine. Nothing here
deploys anything; the operator follows
[deploy/shared-vault/README.md](../deploy/shared-vault/README.md).

## What this slice does not do

- **Portable signatures.** Attribution is *authenticated* — the server
  vouches that the holder of a live credential for `alice` submitted this
  — not cryptographically signed by Alice. Non-repudiation across servers
  is a later layer; the record's shape (author on every event, ids that
  are content hashes) is ready for it.
- **Entity aliasing.** `[[Ada]]` and `[[Ada Lovelace]]` are two entities;
  the engine's alias log is not driven from this door.
- **Search at scale.** `search`, `feed` and the lists scan the logs; a
  ranked index is the engine's job once a shared record outgrows a scan.
- **Reads are not rate-limited**; a member can read as fast as they like.
- **Revocation cannot retract what a client already read.** It does
  refuse the revoked member's next request, and any request whose body
  was still arriving when the revocation landed.

## Verification

`test/sharedMembers.test.ts` (the store), `test/sharedVaultApi.test.ts`
(the door, handler-level: the full owner/alice/bob scenario plus missing,
wrong, foreign and revoked credentials; read-only writes; scope escalation;
cross-member corrections; forged authorship and delegation; invalid
citations and path traversal; validation and bounds; idempotency;
concurrent writes; restart persistence; feed and list pagination; the
crash-heal path; revocation mid-upload; the store never written by the
door), `test/sharedVaultServer.test.ts` (the entrypoint as a subprocess:
provisioning through `bigbrain shared` and `bin/shared.ts`, the
explicit-only rails, every smoke phase through the in-process handler,
and the real-socket run — **skipped loudly where the environment refuses
`bind`**; a skipped socket test is reported, not counted as passed).

The smoke, by hand, against a scratch directory of your choosing — four
phases, each a check that stops on its first failure:

1. **scenario** — provisioning through the real CLI, then the
   owner/alice/bob story: evidence, citations, read, search, correction,
   revoking bob, moderation, dedupe;
2. **persistence** — SIGTERM the server and start another over the same
   directory, then SIGKILL it and start a third: the record, the
   revocation and the feed's sequence survive both, a client resumes
   from its cursor, pre-restart retries still dedupe;
3. **clients** — `curl` (one process per request) as a second,
   independent client reading what `fetch` wrote and writing what it
   reads; both writing concurrently with one contiguous run of sequence
   numbers; identical drops from both landing once;
4. **adversarial** — non-credentials in every shape, revoked and
   read-scoped credentials, narrowing, forged authorship, cross-member
   and owner-as-author attempts, traversal, unknown routes and methods,
   bad bodies and bounds, the rate limit, revocation mid-upload — and the
   feed head at the end proving nothing refused ever landed.

```
bun test/support/sharedVaultSmoke.ts --dir /tmp/shared-smoke          # in-process handler: phases 1, 2, 4; phase 3 reported SKIPPED (no socket = no second client)
bun test/support/sharedVaultSmoke.ts --dir /tmp/shared-smoke --http   # `bin/shared.ts serve` on 127.0.0.1:0, restarted and crashed for real; all four phases
```

Or the scenario phase against a server you started: `bigbrain shared serve --vault … --port 4749`,
then `bun test/support/sharedVaultSmoke.ts --url http://127.0.0.1:4749 --vault … --members … --owner sv_… --alice sv_… --bob sv_…`
(fresh `alice` and `bob` members with write permission; the run revokes bob).

The `--http` run needs a process that may `bind` a loopback socket. A
sandbox that refuses it (EPERM — which Bun reports as "is port 0 in
use?") gets a clean `serve: cannot listen … refused to bind` from the
entrypoint, and the in-process run is what remains; the socket run is
then owed by whoever holds an environment that can listen.
