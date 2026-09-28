# Hosted walking skeleton (#44) — design doc

> **RETIRED 2026-08-26 with the hosted product (#566).** The code this describes lives at tag `hosted-multitenant-final`; nothing here describes the current engine.

Date: 2026-08-07 · Status: **design (for checkpoint 1)** · Owner: Nick + Claude
Feeds Workflow 2 (implement) and Workflow 3 (verify). Plan of record:
`docs/plans/2026-08-07-hosted-walking-skeleton.md`. Engine repo
`~/Projects/BigBrain` is READ-ONLY in design; Workflow 2 edits it.

Issues: #44 (this slice) · #37 (isolation / run-environment contract) · #39
(extension signup) · #40 (model phasing) · #41 (billing) · #46 (arrival
envelope) · #70 (per-tenant model credentials)

---

## 1. Executive summary

**Design 3 — "Contract-first" (split-harness containment, warden scheduling,
one-token curl loop) — wins, grafted with the best of Designs 1 and 2.**

The service is derived from the #37 run-environment contract and builds outward
only what the contract permits. Its load-bearing move is a **split harness**:
the pi agent loop runs **host-side** inside the trusted per-run editor process,
holding the spend-capped Anthropic key only in process memory
(`ModelRuntime.setRuntimeApiKey`, never persisted), while **every model tool
call (read/write/edit/bash) executes inside a per-run Docker container** that
mounts exactly one tenant vault, runs `--network none`, and carries zero
credentials. This makes all three #37 threats structural rather than policy:
cross-vault read fails (no other vault mounted), tenant bleed fails (fresh
container + in-memory session per run), exfiltration fails (guest has no
network; the key never enters it). Because pi runs host-side, it reaches
Anthropic on the standard SDK path — **no relay, no loopback broker, no
unproven custom-`baseUrl` spike** (the dependency that both other designs bet
their key-hiding on). Tenancy is Shape 1 exactly: each tenant gets a provisioned
working-tree vault under `/srv/bigbrain/tenants/<id>/` and **one** resident
process — its token-authed intake API. There is **no per-tenant web viewer**;
"GET the filed result" rides three new path-jailed read routes on the intake
API under the existing `vault:read` scope, so the whole success loop runs on
`curl` with a single bearer token. A new `control/` workspace package (AGPL,
zero engine value-imports; engine never imports Better Auth) owns signup
(Better Auth email OTP + SQLite registry keyed on the stable user id), the
provisioner (idempotent orchestration over `bigbrain init --json`, `bigbrain
auth create --json`, systemd template instances), the **router** (single public
face behind the exe.dev TLS edge, path-routing `/t/<id>/*` with unconditional
identity-header + Cookie stripping), and the **warden** (one resident process
that `fs.watch`es each tenant's `queue/pending/` and spawns `bin/editor.ts`
under a global concurrency cap — the "one switch," no reopened intake poke).

**What was grafted onto Design 3:**

- **From Design 1:** git-hook neutralization to close the shared-uid escape
  vector (all three judges found it); the `POST /account/token` session→drop-
  token re-mint endpoint (D3 deferred it — it is the #39 seam); explicit
  `Cookie`-header stripping at the router; per-tenant Unix users named as the
  next hardening step.
- **From Design 2:** per-tenant spend aggregation in the **registry** (warden
  increments from journal usage after each run — the #40/#41 seam without a
  relay); a machine-checked control-plane import-boundary test; the warden
  concurrency as a config dial (`MAX_CONCURRENT_PASSES`, default 1, K=2 as the
  relief valve); the pre-Workflow-2 task to confirm exe.dev edge forwarding.
- **From the attacker lens:** actually set `Bun.serve` `maxRequestBodySize`;
  per-uid egress restriction on the host-side editor (belt-and-suspenders on the
  one process that holds the key and has network); a warden circuit breaker; and
  `queue.model` as a first-class per-tenant override for #40.

**The one place I overrode a judge:** the implementer picked Design 1 (minimal-
diff) and flagged D3's docker-exec **tool bridge** as the biggest build unknown.
I keep D3 but de-risk the tool bridge explicitly — it is Workflow 2's **first
spike**, gated by a contract test, with a documented weaker fallback (pi-in-
container + host egress proxy) so the week cannot stall on it. Reasoning in §2
and §8; the implementer's dissent is recorded and Nick can veto at checkpoint 1.

---

## 2. Decision record

Every open fork from the plan doc, resolved. Scores below (§8): total across
four criteria — **D3 = 48, D1 = 43, D2 = 41**; judge votes — **operator + attacker
→ D3, implementer → D1**.

### Fork A — pi containment → **Split harness (Docker, host-side pi loop)**

**Decision.** The pi agent loop runs host-side in the trusted per-run editor
process; the key is injected via `ModelRuntime.setRuntimeApiKey` (runtime
override, never written to `auth.json` or any file). Every model tool call runs
in a per-run Docker container: image `bigbrain-run` (ubuntu-24.04-slim + bun +
poppler-utils + git), `--network none`, `--read-only` rootfs, `--pids-limit
256`, `--memory 1g`, `--cpus 1`, pinned by digest. Exactly one rw mount — the
tenant vault at its **identical host absolute path** (so tool/journal/prompt
paths agree with no translation) — plus a tmpfs over `<vault>/memory` for every
non-memory role (memory-blindness by mount, strictly stronger than today's
advisory `Read(./memory/**)` deny). Engine checkout mounted read-only for the
`bigbrain` CLI the editor shells. `SessionManager.inMemory()`, compaction off,
pinned `agentDir` + `systemPromptOverride` via explicit `resourceLoader` so
vault-resident `.pi/` trees never auto-load (closes prompt-injection →
extension-code-execution).

**Why.** #37 isolation IS the named deliverable of this slice, and the split
harness is the only design that makes all three threats structural without
depending on unproven behavior. Gondolin is the named upgrade path but is
disqualified today (self-described experimental; x86_64 only CI-smoke-tested;
QEMU-without-nested-KVM on 2 vCPU degrades to TCG emulation). Bare pi is
rejected: pi's `tools:` list is name-granular with no path/egress scoping, so a
bare run reproduces today's unscoped-read/unrestricted-bash hole with a shared
service key at stake.

**Dissent + resolution.** The implementer and operator both flag the docker-exec
tool bridge (reimplementing pi's builtin read/write/edit/bash as `defineTool`
wrappers whose schemas/semantics the model is tuned around) as the riskiest,
most-underestimated component — and note D2 runs stock pi tools in-container at
higher fidelity. **Resolution:** the tool bridge is Workflow 2's first spike
(§6, Spike-0), proven by a `streamFn` contract test + fake-`docker` shim before
anything depends on it. **Documented fallback** if fidelity or per-call latency
on 2 vCPU proves worse than budgeted: run the whole pi loop *inside* the
container with stock builtin tools, reaching a host-side egress proxy that
injects the key and forwards only to `api.anthropic.com` (this is D2's relay).
The fallback is strictly weaker — key-injection at the proxy, one reachable
endpoint instead of zero — and must be re-flagged in the #37 contract if taken.

**Grafts.**
- **git-hook neutralization (from D1/attacker — closes the vector all three
  judges found).** `lib/git.ts` today shells bare `spawnSync("git")` with no
  `hooksPath`/config sanitization (verified). A poisoned clip that writes
  `.git/hooks/*` in the rw vault mount gets code-exec as the process owner on the
  next host-side commit — cross-tenant read + full-network exfil. Fix: host-side
  git on the hosted path runs with `-c core.hooksPath=/dev/null`, and
  `.git/hooks` is bind-mounted read-only (empty) into the run container. Cheap,
  self-host-safe, and it patches the exact vector.
- **per-uid egress on the host-side editor (attacker).** The one host process
  that holds the key and has network is restricted (nftables, per the `bigbrain`
  uid) to `api.anthropic.com` only, so even a host-side escape cannot exfiltrate
  to an arbitrary destination.
- **per-tenant Unix users = named later hardening,** not skeleton scope (see
  Fork C). Chosen because git-hook neutralization patches the actual vector more
  cheaply than N systemd-user managers + linger + pointer/PATH hazards. This is a
  genuine depth-vs-effort call surfaced to Nick (§8, Q3).

### Fork B — pass scheduling → **One warden (fs.watch), no reopened poke**

**Decision.** One resident control-plane process (`s-tier-warden.service`)
`fs.watch`es every registered tenant's `queue/pending/` and, on signal, acquires
a global semaphore then spawns `bun bin/editor.ts` with a scrubbed from-scratch
env and `S_TIER_VAULT` set. A 60s sweep is the backstop for missed inotify
events. The editor's own lock + debounce gate stay authoritative (a premature
spawn exits in ms before any model call). **No intake poke is reopened.**

**Why.** Verified in source: `pokeStage` never spawns the editor for inbox
arrivals (drop-zone cut 3 — "the timer must be the ONE switch"), and
`queue/pending/` is written synchronously at landing (`lib/intake.ts`). So
`fs.watch` delivers the same sub-second arrival signal with **zero intake diff**
— the operator explicitly flagged D2's reopened poke (`lib/intake.ts` +15 LOC)
as an unnecessary engine change. Per-tenant systemd timers are rejected: N
oneshot bun spawns/minute churn 2 vCPUs and the tenant-blind `s-tier-<name>`
unit names collide. The invariant survives translated: **the warden is the one
switch** — `systemctl --user stop s-tier-warden` halts every pass box-wide.

**Grafts.**
- **concurrency as a dial (D2/operator).** `MAX_CONCURRENT_PASSES`, default 1 on
  the 2-vCPU box, FIFO by arrival, per-vault serialization (the editor lock
  enforces it anyway). K=2 documented as the relief valve — D3's worst latency
  mode is one 20-min pass head-of-line-blocking every tenant; the dial is free
  now, painful to retrofit under load.
- **circuit breaker (D2/attacker).** Suspend a tenant's spawns after N
  consecutive DLQ/failed runs — bounds the shared-key spend-burn a malformed pi
  adapter or a poisoned vault can inflict on everyone.
- **startup reconciliation (operator).** On boot, the warden re-asserts registry-
  derived state (unit enablement, `tenant.env` presence, `/v1/health` probes) so
  a half-provisioned or post-reboot box converges without operator archaeology.
  This is also why we avoid D1's per-uid-nft-as-containment (which silently
  fail-closes every tenant's model path on reboot until re-run): `--network none`
  is declarative and needs no per-boot regeneration.

### Fork C — disk layout → **One `bigbrain` user, opaque tenant ids, pinned token stores**

**Decision.** `/srv/bigbrain/{engine, control/data/control.db,
tenants/<tenant_id>/{vault, tokens.json, run, tenant.env}}` under one service
user `bigbrain` with linger enabled. `tenant_id` = opaque `t_<hex8>` keyed to
Better Auth's **stable user id** (email is a mutable attribute — all three
designs converge here; email-as-key breaks on IdP email change). The per-tenant
token store is pinned via `S_TIER_TOKENS=<tenant>/tokens.json` (verified real at
`lib/auth.ts:73`; the default is a `sha256(vaultRoot)` hash path that silently
orphans if the vault ever moves — pinning kills that trap and keeps tokens
outside the vault tree). Blobs stay in-vault at `.blobs/` (gitignored CAS,
engine convention). Secrets live only in `~bigbrain/.config/s-tier/secrets.env`
(0600), read only by control-plane processes, **never** mounted into containers,
never in `tenant.env`.

**Why + dissent.** Design 1 argued per-tenant Unix users (private homes, token
stores, and structural git-hook confinement). The enforcement boundary for
model-driven code here is the **container mount**, not Unix DAC, so per-tenant
users buy marginal depth at the cost of N user-managers, N linger configs, and
the provisioning-reader's pointer/PATH hazards — the wrong trade for a solo
operator at alpha. The git-hook vector that per-tenant users would confine is
patched directly (Fork A graft). Everything is path-parameterized, so per-tenant
users remain an open later step (§8, Q3).

### Fork D — identity assertion contract → **Two-mode webgate headers, signed when keyed, dark in the skeleton**

**Decision.** `lib/webgate.ts` gains neutral headers **`X-BB-User`** (stable id),
**`X-BB-Email`**, **`X-BB-Assert`** = `v1;exp=<unix>;sig=<hex HMAC-SHA256(
S_TIER_ASSERT_KEY, "v1\n<user>\n<email>\n<exp>")>`. When `S_TIER_ASSERT_KEY` is
set (the hosted box sets it; the control-plane router signs), the gate requires a
valid unexpired signature. When unset, behavior is today's `x-exedev-*` trusted-
header contract **bit-for-bit** — self-host single-user keeps zero auth setup
forever (fixed decision 2). The router additionally strips all inbound
`X-BB-*`/`X-ExeDev-*`/`X-Forwarded-*` **and `Cookie`** before forwarding.

**Why.** The scariest edge failure is a naive proxy forwarding client-supplied
`X-ExeDev-Email` (identity forgery from one missing strip rule). An HMAC makes
header-stripping **defense-in-depth** instead of the whole security model — the
operator and attacker both scored this as the strongest #39 answer. D1/D2 defer
to unsigned trusted-headers only; D3's contract is strictly stronger for the same
~60 LOC.

**Scope note.** This ships **implemented and tested but dark**: the skeleton's
live drop path is bearer-token-authed inside the tenant instance, so no live
surface exercises `X-BB-Assert` in this slice. Its first real exercise is #39's
session-riding extension drop. The webgate unit vectors (expired sig, wrong key,
header smuggling, mixed legacy+signed) are the only guard until then — keep them
adversarial.

### Fork E — control-plane boundary + licensing → **`control/` workspace, AGPL, zero engine value-imports**

**Decision.** New top-level `control/` workspace package inside the BigBrain
repo, **AGPL-3.0** (business model v1.2 default). Better Auth, its SQLite driver,
and nodemailer live **only** in `control/package.json`; the engine never learns
Better Auth exists (fixed decision 2). `control/` **never value-imports** engine
`lib/*` (which also dodges the import-time `VAULT_ROOT` resolution at
`lib/manifest.ts:96`) — `import type` only. All engine integration is over three
seams: **subprocess** (`bigbrain init --json`, `bigbrain auth create --json`,
spawning `bin/editor.ts`), **HTTP** (router → tenant `127.0.0.1` ports;
health/whoami probes), **filesystem convention** (`/srv/bigbrain` layout,
`tenant.env`, `queue/pending` watch).

**Why + graft.** Same-repo (one `git pull --ff-only` deploy) but package-
boundaried — the package boundary, not the repo boundary, protects the engine's
self-host story. Chose D3's strict zero-value-import posture over D2's "value-
import `lib/auth.ts` only" because the provisioner is a subprocess orchestration
anyway and `bin/auth.ts --json` gives it a clean contract. **Graft (D2/
operator):** a repo test that greps `control/` imports against the allowlist so
the boundary cannot rot.

### Fork F — edge routing + port allocation → **Caddy on `bigbrain.cool` → router :4700, path-based, registry-allocated ports** *(REVISED at checkpoint 1, 2026-08-08)*

**Checkpoint-1 revision.** The exe.dev edge is dropped in favor of **Caddy +
Let's Encrypt terminating TLS for `bigbrain.cool`** (Nick's domain) on a
standard VPS, reverse-proxying to the router on `127.0.0.1:4700`. Reasons:
Nick owns the domain and wants the product on it; exe.dev per-VM
public-forward is uncertain and edge-domain-locked; the split-harness needs
rootful Docker + full nftables egress control that a managed edge may not
expose. This also collapses the separate launch-host migration. Everything
below about path-routing, header/Cookie scrubbing, and per-tenant port
allocation is **unchanged** — only what terminates TLS at the front changed
(the design always treated the edge as one thin, swappable seam). Caddy
auto-manages the cert now that we control the apex domain.

**Original decision (superseded at the TLS layer only).** The exe.dev edge
terminates TLS for `bigbrain.exe.xyz` and forwards the VM's default public
port to the control-plane router on `127.0.0.1:4700`. Tenant
addressing is path-based: `/t/<tenant_id>/v1/*` → strip prefix, scrub identity/
forwarding/Cookie headers → `127.0.0.1:<api_port>` with `Authorization` intact
(authz stays in-instance, fail-closed `verifyToken` — the router routes, it never
authenticates drops). Port allocation is a registry column, sequential from
20100, written into `tenant.env`, consumed by `bin/api.ts`'s existing `PORT` knob
via a `s-tier-api@.service` template with `EnvironmentFile=/srv/bigbrain/tenants/
%i/tenant.env` (the fix for the tenant-blind unit-name collision). Per tenant:
**one** resident process (the intake API). Subdomain-per-tenant (needs wildcard
DNS) and custom domains (Caddy) are the named future.

**Graft (D2/operator).** A pre-Workflow-2 task to **confirm** `bigbrain.exe.xyz`'s
edge forwards its default public port to unauthenticated (non-exe.dev-login)
clients — the whole public surface rides this cache-guitar assumption. Fallback:
Caddy + Let's Encrypt on a raw port. Surfaced to Nick (§8, Q4) since he holds the
exe.dev knowledge.

### Fork G — arrival latency → **warden fs.watch + 10s debounce; run STARTS ≤~15s**

**Decision.** "Pass runs on arrival" = the run **starts** within ~15s of `POST
/drop` returning on a quiet box. Mechanism: warden `fs.watch` on `queue/pending`
fires <1s after the landing commit; hosted tenants are provisioned with
`queue.debounce: '10s'` (a `vault.yaml` knob via the new InitSpec `queue` block;
a fresh tenant's first drop has no stamp so the gate is open immediately); editor
spawn + lock + claim ~2s; container start ~1–3s; a one-arrival pass ~30–90s.
**Budget:** p50 clip→filed-and-committed ≈ 60–105s; p95 ≤ 5 min under cross-
tenant contention; hard ceiling one 20-min pass timeout. The 60s sweep is only a
missed-event backstop. This deliberately does **not** touch `EDITOR_TICK_MS`,
`editor.timer`, or `pokeStage` — self-host latency semantics are unchanged, and
the tick-≤-debounce invariant is irrelevant to hosted tenants because the warden
replaces the tick entirely. D1/D2 land ~90s p50 (60s tick/debounce); D3's warden
is the fastest first-filing, which the plan explicitly wants for the demo "aha."

---

## 3. Architecture

### Components

| Component | Home | Role |
|---|---|---|
| **exe.dev edge** | exe.dev | TLS for `bigbrain.exe.xyz`; forwards default public port → box `127.0.0.1:4700` |
| **Router** (`control/`) | box, resident | Single public face on :4700; Better Auth OTP + session; `/t/<id>/*` reverse-proxy with header/Cookie scrub; signup/provision; `/me`; `/account/token` |
| **Registry** (`control/`) | box, `control.db` SQLite | users, tenants, ports, token ids, status, spend/ingest counters; keyed on stable user id |
| **Provisioner** (`control/`) | box, invoked by signup | idempotent tenant creation over engine subprocess primitives |
| **Warden** (`control/`) | box, resident | `fs.watch` each tenant `queue/pending/`; global semaphore; spawns `bin/editor.ts`; circuit breaker; spend metering; startup reconciliation — the one switch |
| **Tenant intake API** (engine `bin/api.ts`) | box, N resident | per tenant, one process, token-authed drop + read-back on `127.0.0.1:<api_port>` |
| **Per-run editor** (engine `bin/editor.ts`) | box, ephemeral | host-side pi loop; holds key in memory; drives the run container; lock/commit/journal in host pid domain |
| **Run container** (`bigbrain-run`) | box, per-run | `--network none`; one vault mount; executes model tool calls only |

### Flow: signup → provision → drop → pass → read

```
SIGNUP
  curl POST https://bigbrain.exe.xyz/auth/otp/request {email}
     → router → Better Auth emails OTP (SMTP from secrets.env)
  curl POST /auth/otp/verify {email, code}  → Set-Cookie session
  curl POST /signup/complete  (session)
     → router → PROVISIONER:
        1. allocate tenant_id=t_<hex8>, api_port from registry (UNIQUE)
        2. mkdir /srv/bigbrain/tenants/<id>/{vault,run}
        3. spawn `bun engine/bin/init.ts --vault .../vault --json --no-install`
           InitSpec { role:host, auth:api, engine:pi,
                      queue:{debounce:'10s', model:<frontier>},
                      domains:<starter trio>,
                      integrations:{'vault-clean':{enabled:false}} }
           (ANTHROPIC_API_KEY in child env for the preflight probe only)
        4. write .state/role='host\n' + mkdir .state/logs
        5. spawn `bigbrain auth create --json --name signup --owner <email>
                  --kind person-device --scopes inbox:write,vault:read`
           with S_TIER_TOKENS=<tenant>/tokens.json pinned  → {id, token, scopes}
        6. write tenant.env {S_TIER_VAULT, PORT=<api_port>, S_TIER_TOKENS} 0600
        7. systemctl --user enable --now s-tier-api@<tenant_id>
        8. probe GET :<port>/v1/health, then /v1/whoami with the minted token
        9. registry insert status=active
     → 201 { tenant_id, api_base:"/t/<id>", drop_token }   (token shown ONCE)

DROP
  curl -H "Authorization: Bearer bb_<id>_<secret>" \
       --data-binary @clip.md \
       "https://bigbrain.exe.xyz/t/<id>/v1/drop?dest=inbox&name=clip"
     → edge → router (strip X-BB-*/X-ExeDev-*/X-Forwarded-*/Cookie, keep Auth)
     → 127.0.0.1:<api_port> /v1/drop
     → verifyToken (fail-closed) → stampIntake provenance (from:<email>,
        from_kind:person, source:api) → land in references/ → commit →
        queue/pending/<msg>.json written synchronously → 200 {path, id}

PASS (server-side, on arrival)
  warden fs.watch fires <1s → acquire semaphore →
  spawn `bun bin/editor.ts` (scrubbed env: PATH,HOME,S_TIER_VAULT,S_TIER_ROLE,
     S_TIER_TOKENS, ANTHROPIC_API_KEY from secrets.env) →
  host-side: acquire .state/editor.lock, claim queue msg, assemble prompt →
  pi session (key in memory via setRuntimeApiKey) drives run container:
     tool calls → docker exec into bigbrain-run (vault rw @ identical path,
     memory/ tmpfs, --network none) →
  model streams to api.anthropic.com (host-side, standard SDK path) →
  final assistant text ends with ```outcomes block →
  host-side: detectFiled verifies against staged diffs → commit → journal
     journal/queue/<runId>.json { ...existing, engine:'pi', toolPolicy,
        usage:{input_tokens,output_tokens,cost_usd}, sampling,
        containment:{backend:'docker', image_digest, network:'none'} }
  warden post-run: read usage → increment registry spend/ingest counters

READ
  curl -H "Authorization: Bearer bb_..." \
       "https://bigbrain.exe.xyz/t/<id>/v1/status"
     → {queue:{pending,running,failed}, last_run:{outcomes, model, wallMs, ...}}
     (poll until pending=0 and last_run.outcomes shows "<ref> absorbed")
  curl ".../t/<id>/v1/ls?dir=entities"   → the citing note path
  curl ".../t/<id>/v1/file?path=entities/<note>.md"  → sources: <ref id>
  curl ".../t/<id>/v1/file?path=journal/queue/<runId>.json"  → the report
```

### Disk layout on the box

```
/srv/bigbrain/
  engine/                        # git clone, ro deploy key, world-readable
  control/
    data/control.db              # Better Auth + registry, 0600 bigbrain
  tenants/<t_hex8>/
    vault/                       # working repo: references/ entities/ domains/
      .blobs/                    #   library/ journal/ + .blobs CAS + .state
      .state/{role,logs,editor.lock,queue/}
    tokens.json                  # pinned via S_TIER_TOKENS, sha256-only records
    tenant.env                   # S_TIER_VAULT, PORT, S_TIER_TOKENS — NO secrets
    run/                         # per-run scratch
~bigbrain/.config/s-tier/secrets.env   # 0600: ANTHROPIC key + SMTP; control only
/usr/local/bin/bun               # shared, ro
```

---

## 4. Run-environment contract (the #37 deliverable)

**RUN-ENVIRONMENT CONTRACT v0** — one hosted pass run (role editor | memory |
import) for one tenant T, spawned by the warden. Self-host `claude-cli` runs are
out of scope and unchanged.

1. **Process topology.** A host-side runner process (trusted engine code) holds
   the single editor lock (`.state/editor.lock`, host pid — pid-liveness
   `acquireLock`/`reclaimStale` stay in one pid domain, the reason containers do
   not wrap the whole process), assembles the prompt from vault-local
   `prompts/<role>.md`, runs the pi agent loop in-process, verifies outcomes
   against staged git diffs, commits, journals. A per-run Docker container
   (image `bigbrain-run`, pinned digest) executes every model tool call via
   `docker exec`; created at run start, force-removed in a `finally` alongside
   `session.dispose()`.

2. **Mounts (container).** Exactly: (a) `/srv/bigbrain/tenants/T/vault` **rw** at
   its identical host absolute path; (b) a **tmpfs over `<vault>/memory`** for
   every role except `memory` (memory-blindness by mount, stronger than the
   `Read(./memory/**)` deny-pattern); (c) engine checkout **ro** (for the
   `bigbrain` CLI the editor prompt shells: search / blob path / links / queue);
   (d) **`.git/hooks` bind-mounted ro (empty)** — with host-side git also run
   `-c core.hooksPath=/dev/null` — so a poisoned clip cannot arm a hook the host
   commit later executes. Nothing else: no home dirs, no `secrets.env`, no
   `control.db`, no other tenant path, no docker socket. Rootfs `--read-only`;
   `/tmp` tmpfs.

3. **Network (container): `--network none`.** The run's ONLY egress is the
   runner's host-side TLS stream to `api.anthropic.com`. No in-guest route to
   loopback (other tenants' `127.0.0.1` ports), the control plane, or the
   internet — the #37 "no open egress" clause made literal, closing the
   `gateDecision` viaEdge=false loopback-collapse without touching webgate.

4. **Credentials.** The container carries **none, ever**. The runner receives
   `ANTHROPIC_API_KEY` in its scrubbed host env from the warden (which reads
   `~/.config/s-tier/secrets.env`) and hands it to pi via
   `setRuntimeApiKey` — a runtime override, never persisted, never in a file,
   never in container env, therefore unreadable by any bash-tool child. The host-
   side runner's own egress is nftables-restricted to `api.anthropic.com` only.

   > **NAMED DEVIATION (fixed decision 4, cites #70).** The injected credential
   > is **one service-wide spend-capped Anthropic key shared across all
   > tenants**, not a tenant-scoped credential as #37's rule requires. Blast
   > radius under this contract: a fully compromised run can spend the shared
   > cap (it cannot read, exfiltrate, or reuse the key — the key is not present
   > in the guest); it cannot touch another tenant's data. **Graduation:** #70
   > per-tenant Anthropic workspace keys via the Admin API drop into the same
   > `setRuntimeApiKey` injection point (warden selects the key by tenant); the
   > guest-side contract does not change. **#70 must land before signup opens
   > beyond personally-known alphas.** The warden's circuit breaker + per-tenant
   > registry spend counters bound and observe the deviation in the meantime.

5. **Env.** Container: `S_TIER_VAULT=<vault>`, `S_TIER_ROLE=<role>`,
   `HOME=/tmp/run-home`, minimal PATH. Runner (host): `PATH, HOME, S_TIER_VAULT,
   S_TIER_ROLE, S_TIER_TOKENS=<tenant>/tokens.json, ANTHROPIC_API_KEY` — built
   from scratch by the warden, never inherited (the `{...process.env}` spread in
   `run.ts` does not apply on the pi path).

6. **Tools.** pi session: `noTools: 'all'`; `customTools = read, write, edit,
   bash` — each a `defineTool` wrapper that `docker exec`s into the run container
   (grep/find/ls ride bash; the vault Bash write-guard does not apply to
   sanctioned machine passes). The tool list is journaled from the same value
   that configures the session (enforcement and record cannot drift). WebFetch/
   WebSearch/Task equivalents do not exist in the run. Intra-vault write
   discipline (foreign-path writes, `prompts/` tampering) stays prompt-level +
   tripwire + staging-exclusion as today — declared **soft by design**; the HARD
   guarantees of this contract are inter-tenant, egress, and credential.

7. **Resource envelope.** Container: `--memory 1g --cpus 1 --pids-limit 256
   --read-only`. Session: `prompt()` raced against 1_200_000 ms (today's
   `runClaude` timeout, verified `run.ts:147`) → `abort()` + `dispose()` +
   `docker rm -f`; compaction disabled, retry `maxRetries: 2`; box-wide
   concurrency `MAX_CONCURRENT_PASSES` (default 1). Model + thinkingLevel from
   tenant `vault.yaml` queue config via pi-ai `getModel` (#40's per-run plumbing;
   frontier-first-N is warden policy, not engine code).

8. **Record.** `journal/queue/<runId>.json` keeps every existing field (model,
   auth, promptSha256, engineCommit, wallMs, commit, outcomes, report) and adds
   `engine:'pi'`, `toolPolicy` (the four tool names), `usage
   {input_tokens,output_tokens,cost_usd}` summed from session messages,
   `sampling` (real values, replacing the `cli-defaults` sentinel),
   `containment {backend:'docker', image_digest, network:'none'}`. The journal is
   the per-tenant spend meter #40/#41 read; the warden aggregates it into the
   registry.

9. **Output contract.** The runner extracts the final assistant text where the
   former JSON `.result` string came from, so `parseOutcomes`/`detectFiled` and
   the 1245-line worker suite machinery are untouched. The pass must end with a
   well-formed ```outcomes``` block; a malformed adapter otherwise burns 3 model
   retries per arrival into the DLQ — hence the Spike-0 contract test and the
   warden circuit breaker.

10. **Side-spawns.** `pokePublish`/receipts fire host-side from the runner
    (trusted), never from the guest; publish is fail-soft with no origin remote.
    Nothing inside the container may spawn anything host-visible.

---

## 5. Tenant API spec

Base: `https://bigbrain.exe.xyz` (exe.dev edge TLS → router `127.0.0.1:4700`).
Two credential classes: Better Auth **session cookie** (control-plane endpoints
only) and per-tenant **bearer drop token** `bb_<id>_<secret>` (tenant endpoints,
verified fail-closed inside the tenant instance). Wire errors stay undifferentiated
`401` / scope-naming `403` / `413` / `429`+`Retry-After` per today's contract.
The router strips all inbound `X-BB-*`/`X-ExeDev-*`/`X-Forwarded-*`/`Cookie`
before forwarding `/t/<id>/*`, and forwards `Authorization` intact.

### Control plane (session or none)

> **REVISED 2026-08-08: "Sign in with Google", not email OTP.** Removes email
> delivery from the skeleton entirely (Better Auth Google social provider —
> Google is the managed sender). The two `/auth/otp/*` endpoints below are
> replaced by the standard Better Auth OAuth pair. Everything downstream
> (session cookie, `/signup/complete`, provisioning, allowlist gate) is
> unchanged — only the identity-proof step differs.

- `GET /api/auth/sign-in/google` → 302 to Google consent (Better Auth default
  mount). Requires the OAuth client (ID in config, secret in `secrets.env`),
  redirect `https://bigbrain.cool/api/auth/callback/google`.
- `GET /api/auth/callback/google` → Better Auth verifies the Google identity,
  then **allowlist-gates on the verified email (hard requirement, checkpoint
  1): on-list → `Set-Cookie` session; off-list → 403 with no account created
  and no session** (the allowlist is a registry table / `secrets.env` list;
  `alpha@example.com` only for the alpha). Holds until #70 widens signup.
- `POST /signup/complete` (session) → provisions if absent → 201 `{tenant_id,
  api_base:"/t/<id>", drop_token}` — `drop_token` returned **exactly once** (only
  its sha256 persists thereafter). Idempotent re-call after provisioning returns
  `{tenant_id, api_base}` with no token.
- `GET /me` (session) → `{user_id, email, tenant_id, api_base, status}`.
- `POST /account/token` (session) `{name}` → mints an **additional** person-
  device token (owner = session email), shown once. **[graft from D1]** — the
  explicit #39 extension seam (session → bearer wiring). D3 had deferred this to
  "a later endpoint"; it costs ~30 LOC now and unblocks #39.

### Tenant data plane (bearer; proxied to that tenant's `bin/api.ts`)

Existing engine routes, unchanged unless marked **NEW**:

- `GET /t/<id>/v1/health` → `{ok:true}` (unauthed; provisioning + liveness
  probe; router 404s an unknown tenant with no timing/behavior distinction from
  unprovisioned).
- `GET /t/<id>/v1/whoami` (bearer) → `{id, name, owner, kind, scopes}` — token-
  validity probe, used by provisioning step 8.
- `POST /t/<id>/v1/drop?dest=inbox&name=<slug>&poke=false` (bearer, scope
  `inbox:write`) — the hosted twin of `bigbrain drop`. Body: raw markdown OR
  JSON `{content, attachments:[{name, b64}]}`. **Whole request capped at 10 MB
  (`Bun.serve` `maxRequestBodySize` — set it explicitly; today it is
  unenforced), `413` over.** Larger originals go via `PUT /v1/blob` per blob.
  Server strips `RESERVED_KEYS` and stamps provenance from the verified token
  (`source:api`, `submitted_by:<token id>`, `submitted_via:<token name>`,
  `from:<owner email>`, `from_kind:person`); a payload may self-assert
  `from_kind:agent`, never `person`. Response `{path, id}` — `id` is the stable
  reference id; byte-identical re-drops return the **same** id and enqueue
  nothing (dedup on pre-stamp sha256 — document it so integration authors don't
  build retry loops that wait forever on a second filing). Rate limit
  30 req/min/token.
  - **#46 ENVELOPE FIELDS** (optional, additive frontmatter, carried verbatim —
    not in `RESERVED_KEYS`, so pass-through is structurally free today; named
    here as contract rather than accident): `stream` (string — source identity,
    e.g. `"granola"`, `"chrome-extension"`), `key` (string — stable identity of
    the logical item within its stream), `seq` (integer — monotonic order within
    stream+key), `supersedes` (string — reference id this item replaces). The
    skeleton persists them into the landed reference's frontmatter unmodified;
    editor-side supersede/ordering semantics are #46's own follow-on, not
    skeleton scope.
- `POST /t/<id>/v1/enqueue {refs?, guidance?}` (bearer, `inbox:write`) — existing
  directive door, unchanged. No poke; the warden's `queue/pending` watch picks it
  up.
- `PUT /t/<id>/v1/blob` (bearer, `inbox:write`) → `{sha256, bytes, existed}`;
  `GET /t/<id>/v1/blob/<sha256>` (`vault:read`); `DELETE` (person-device tokens
  only) — existing CAS surface.
- **NEW** `GET /t/<id>/v1/status` (bearer, `vault:read`) → `{queue:{pending,
  running, failed}, last_run:{run, startedAt, wallMs, outcomes, model} | null}`
  from `queue/` dir counts + the newest `journal/queue/*.json`. The "watch it get
  filed" poll: `pending` goes 1→0 and `last_run.outcomes` shows `<ref>
  absorbed`.
- **NEW** `GET /t/<id>/v1/ls?dir=<vault-relative>` (bearer, `vault:read`) →
  `{entries:[{name, dir:bool, bytes, mtime}]}`. **Jail:** realpath-resolved
  result must remain under the vault root AND under one of `references/`,
  `entities/`, `domains/`, `library/`, `journal/`, `inbox/unsorted/`; anything
  else (`.state`, `.env`, `.git`, `.blobs`, `memory/`, `prompts/`, path
  traversal) → `403`.
- **NEW** `GET /t/<id>/v1/file?path=<vault-relative>` (bearer, `vault:read`) →
  raw file body (content-type by extension). Same jail. Read-back reads
  `references/` and `entities/` — the committed canonical record — never
  `inbox/` desk copies.

**Skeleton curl loop:** drop → poll `/v1/status` until `pending=0` →
`/v1/ls?dir=entities` → `/v1/file?path=<citing note>`. One token, no cookies.

### Future (dark in skeleton, contract shipped)

`/t/<id>/app/*` — router validates session, injects signed
`X-BB-User`/`X-BB-Email`/`X-BB-Assert`, forwards to a tenant web viewer with
`S_TIER_WEB_ALLOW=<email>` + `S_TIER_WEB_READONLY=1`; #39's extension drops ride
the webgate carve-out here.

---

## 6. Work breakdown for Workflow 2

~10 agents, git worktrees, one PR. Gates: `bun test` green, `oxlint` silent (no
CI — runs in the implement workflow). Engine changes keep the `claude-cli`
dispatch path **byte-identical** so the 1245-line worker suite passes unmodified
(default branch still spawns `claude`; `expect(cmd).toBe("claude")` assertions
hold). "Engine" = the sacred `lib/`/`bin/` trees; "control" = the new package.

**Pre-flight (Nick, parallel to the build — gates deploy, not the code):**
Stand up a standard Linux VPS (~4 vCPU / 8 GB / 80+ GB), point `bigbrain.cool`
DNS A-record at it, hand over ssh. Provide the 3 alpha allowlist emails and an
email sender (transactional provider key or SMTP creds) before go-live. None
of this blocks Workflow 2 — the box only needs to exist by checkpoint 2.

### Spike-0 — pi tool-bridge fidelity — ✅ DONE 2026-08-08 (branch `hosted-skeleton`, commit 1e4d1f6; 814 tests green, oxlint silent, additive-only)

> **`docs/plans/spike-0-findings.md` is now AUTHORITATIVE over the pi API
> specifics in §4.6 and this Item where they differ.** Headlines: keep pi's
> OWN read/write/edit/bash tools and override only their `operations` backend
> via `create*ToolDefinition(root,{operations})` + an inline extension (NOT
> `noTools:'all'` + hand-rolled `defineTool` — that never registers); offline
> seam = install the fake on the ModelRuntime instance (`runtime.streamSimple`);
> `.pi/` isolation via first-class loader flags (`noExtensions/noSkills/…`) +
> throwaway `cwd`/`agentDir`; final text via `session.getLastAssistantText()`;
> `getModel` from `@earendil-works/pi-ai/compat` (or `ModelRuntime.getModel`),
> ids bare + provider separate. **Item A must verify pi-ai can address the
> vault's configured model id (e.g. `claude-opus-5`), not just the builtin
> catalog the spike observed (`claude-opus-4-5` etc.) — a correctness gate for
> #40 model plumbing.** Original spec below kept for provenance.

**(Original) Spike-0 — pi tool-bridge fidelity (BLOCKING, first, riskiest)**

Prove `createAgentSession` with `noTools:'all'` + 4 `customTools` (read/write/
edit/bash) as `docker exec` wrappers produces a well-formed ```outcomes``` block
round-trip against a **fake-`docker` shim** and pi's injected `streamFn` testing
harness. Deliverables: `lib/editor/piRun.ts` (session assembly, ~200 LOC),
`lib/editor/containment.ts` (4 `defineTool` wrappers + container lifecycle +
`.git/hooks` ro-mount, ~150 LOC), `test/piRun.test.ts`, `test/containment.test.ts`.
**Sized 2–3 days.** Gate for Item A. **Fallback if fidelity/latency fails:** pi-
in-container + host egress proxy (D2's relay) — re-flag the weaker isolation in
§4. Interface out: `piRun(opts) → final assistant text string` (same contract
`runClaude` already returns).

### Item A — engine: pi runner behind ClaudeExec

`lib/editor/run.ts` dispatch on new manifest `queue.engine: 'claude-cli' (default)
| 'pi'` (~40 LOC — default path byte-identical); wire in Spike-0's `piRun.ts` +
`containment.ts`; `lib/editor/worker.ts` journal fields (usage/toolPolicy/
sampling/containment, ~25 LOC); `lib/manifest.ts` `parseQueueConfig` (~10 LOC).
Because dispatch is inside `runClaude`, editor + memory + import passes swap
together. **Depends on Spike-0.** Interface: `runClaude` returns the same string;
journal gains the new fields.

### Item B — engine: read-back routes + body cap  *(parallel with A, C, D)*

`lib/api.ts` `GET /v1/file`, `/v1/ls`, `/v1/status` under `vault:read`; realpath
path-jail + allowlist trees (deny `.state`/`.env`/`.git`/`.blobs`/`memory`/
`prompts` + traversal); set `Bun.serve` `maxRequestBodySize = 10 MB` explicitly.
~150 LOC + `test/api.test.ts` (socket-free `new Request()`). Independent file —
no dependency on Spike-0. Interface: three HTTP routes on the tenant instance.

### Item C — engine: webgate assertion contract  *(parallel; pure module)*

`lib/webgate.ts` `X-BB-User`/`X-BB-Email`/`X-BB-Assert` HMAC when
`S_TIER_ASSERT_KEY` set, `x-exedev-*` back-compat when unset; extend `isViaEdge`
to the `x-bb-*` markers. ~60 LOC + `test/webgate.test.ts` adversarial vectors.
Ships dark. Interface: `gateDecision` unchanged for consumers; new signed mode
behind the env flag.

### Item D — engine: hosted provisioning primitives  *(parallel; light coord with A on containment.ts)*

`InitSpec` gains `engine?: 'pi'|'claude-cli'` + `queue?: {debounce?, model?}` →
generated `vault.yaml` queue block; `runPreflight` `checks: 'hosted'` skips
`claude-on-jobs-path` + `claude-auth` (both fail-level today — verified — and
would hard-block init on the claude-less box), checks `docker` + `ANTHROPIC_API_
KEY` in `process.env` instead; `bin/auth.ts` gains `--json` (`{id, token,
scopes}`); git-hook neutralization (`-c core.hooksPath=/dev/null` in the hosted
git path — coordinate the `.git/hooks` ro-mount half with A's `containment.ts`).
~40+40+15 LOC. Interface: `bigbrain init --json --no-install` accepts the new
fields; `bigbrain auth create --json` emits the token contract the provisioner
parses.

### Item E — control: server + router + registry

`control/` package (AGPL, zero engine value-imports); `Bun.serve` `127.0.0.1:4700`;
**Better Auth Google social provider** (no email/SMTP dep) + SQLite (`users,
tenants, ports, token_ids, status, spend_usd, ingest_count, allowlist`);
allowlist gate on the verified Google email at callback; router `/t/<id>/v1/*`
strip `X-BB-*`/`X-ExeDev-*`/
`X-Forwarded-*`/`Cookie` → `127.0.0.1:<api_port>` with `Authorization` intact;
`POST /signup/complete` → provisioner; `GET /me`; `POST /account/token`. ~700 LOC.
**Depends on D** (calls `init --json`, `auth create --json`). Interface: HTTP
control plane + the provisioner/warden seams.

### Item F — control: provisioner

`control/provision.ts` — the 9-step idempotent orchestration in §3, each step
subprocess/file-level, never imports engine lib; `control/deploy/s-tier-api@
.service` template (`EnvironmentFile=/srv/bigbrain/tenants/%i/tenant.env`). ~350
LOC. **Depends on D, E.** Interface: `provision(email) → {tenant_id, drop_token}`.

### Item G — control: warden

`control/warden.ts` resident; `fs.watch` each tenant `queue/pending/` + 60s
sweep; global semaphore (`MAX_CONCURRENT_PASSES`, default 1); spawn `bun bin/
editor.ts` with the scrubbed env from §4; per-uid egress restriction applied to
the spawn; circuit breaker (suspend after N consecutive DLQ); startup
reconciliation (re-assert units/`tenant.env`/health from registry); post-run
read journal usage → increment registry `spend_usd`/`ingest_count`. ~300 LOC.
**Depends on A** (the pi path it spawns), **E** (registry). Interface: the one
switch; env contract to `bin/editor.ts`; `#40` frontier→economy flip is a warden
policy over `ingest_count` writing `queue.model`.

### Item H — deploy + bootstrap  *(parallel throughout)*

`control/deploy/{Dockerfile.run, s-tier-api@.service, s-tier-warden.service,
s-tier-control.service, bootstrap.sh}`. Bootstrap: install bun (absolute-path
discipline — `{{BUN}}=process.execPath`, non-interactive ssh PATH gotchas),
docker-ce, build `bigbrain-run` image + pin digest, create `bigbrain` user +
`loginctl enable-linger`, clone engine (ro deploy key), `bun install`, load
units, **Caddy + Let's Encrypt for `bigbrain.cool` → `127.0.0.1:4700`**
(replaces exe.dev-edge registration), nftables base (host-side editor egress
→ `api.anthropic.com` only). Secrets per fixed decision 5: Nick pastes via
`ssh box 'umask 077; cat >> ~/.config/s-tier/secrets.env'`. ~250 lines.
Interface: the box.

### Item I — import-boundary test + house-pattern e2e

`control/test/imports.test.ts` (grep `control/` imports against the allowlist);
`control/test/e2e.test.ts` + `test/` additions per §7. ~450 LOC. **Depends on
all.**

**Parallelism.** Spike-0 first. Then A (after Spike-0), B, C, D all parallel. E
after D; F after D+E; G after A+E. H parallel throughout. I last. Critical path:
Spike-0 → A → G → I.

---

## 7. Test / verify plan

### Sandbox e2e (house pattern — Workflow 2 gate)

`mkdtemp` scratch vaults, injected deps, `S_TIER_VAULT` exported before `bun
test`, no sockets, no box, no live model:

- **piRun contract test** (Spike-0): injected `streamFn` → well-formed
  ```outcomes``` round-trip. The DLQ-burn guard — a malformed adapter otherwise
  burns 3 model runs per arrival.
- **containment tool-bridge test:** `piRun`/`containment` against a fake-`docker`
  shim; assert mount plan (vault rw, memory tmpfs, engine ro, `.git/hooks` ro),
  `--network none`, and read/write/edit/bash semantics.
- **provisioner test:** spawn real `bin/init.ts` (`--no-install`) + `bin/auth.ts
  --json` against a scratch tenant dir; assert `InitResult.ok`, `.state/role`
  marker, token JSON, `whoami` via `makeApiHandler`.
- **drop→file e2e:** git-init'd fixture vault (`detectFiled` needs staged diffs);
  `makeApiHandler` drop; `runQueue` with an injected `exec` stub standing in for
  the docker adapter (the `filingExec` pattern); assert filed `references/`/
  `entities/` note + `git log` + journal usage fields.
- **webgate HMAC vectors:** expired sig, wrong key, header smuggling, mixed
  legacy+signed.
- **read-back jail cases:** `/v1/file` + `/v1/ls` traversal + dot-tree denial.
- **router scrub test:** assert `X-BB-*`/`X-ExeDev-*`/`X-Forwarded-*`/`Cookie`
  stripping (pure-function discipline).
- **import-boundary test:** grep `control/` imports against the allowlist so the
  zero-value-import rule cannot rot.

### Live on the box (Workflow 3)

- **Success path:** curl OTP signup → provision → drop clip → poll `/v1/status`
  until `pending=0` → `GET /v1/file` the cited note + journal record. The #44
  success criterion.
- **Tenant B isolation (#37):** B's pass cannot read A's vault (only one
  mounted); B's token cannot read A's files (`403`/`404`); prove `--network none`
  (no external egress, no loopback to A's api port from inside a run); prove the
  git-hook vector is dead (a clip that writes `.git/hooks/*` does not execute on
  the next commit).
- **Negative auth:** wrong/missing token → undifferentiated `401`; wrong scope →
  `403`; `Cookie`/`X-BB-*` injection at `/t/*` ignored.
- **Ops failure modes:** reboot convergence (warden reconciliation); `fs.watch`
  reliability under load (60s sweep bounds misses); a wedged warden halts passes
  cleanly (the one switch); circuit breaker trips after N DLQs.
- **Adversarial lenses** (correctness, #37 threat model, auth/session, ops) with
  independent refutation per finding; fix loop.

---

## 8. Judge scores + open questions for Nick

### Scores (per lens; four criteria each: smallest-diff / sets-up-future / ops-burden / isolation)

| Design | Implementer | Operator | Attacker | Total | Votes |
|---|---|---|---|---|---|
| **D1 minimal-diff** | 5,4,4,5 = **18** | 4,3,2,3 = **12** | 4,3,3,3 = **13** | **43** | implementer |
| **D2 queue-centric** | 3,4,3,4 = **14** | 3,4,4,4 = **15** | 2,4,3,3 = **12** | **41** | — |
| **D3 contract-first** | 3,5,3,4 = **15** | 3,5,4,5 = **17** | 3,5,4,4 = **16** | **48** | operator, attacker |

**Winner: D3.** Highest total, two of three votes. The implementer's D1 vote is
driven by smallest-engine-diff (genuinely true: D1's engine diff is ~325 LOC vs
D3's ~650–900) and by D1's per-tenant Unix users structurally confining the git-
hook vector. I override because: (1) #37 isolation is the **named deliverable**
and D3 is structurally strongest on all three threats without depending on the
unproven pi-ai custom-`baseUrl` behavior that D1 (silently) and D2 (with a key-
in-guest fallback) both bet on; (2) the operator's decisive principle — D3's
riskiest part fails **loudly pre-deploy** (contract test), while D1's fail
**silently post-deploy** (per-uid nft after reboot, guessable broker
placeholder); (3) the tool-bridge build risk (the implementer's real objection)
is de-risked to Spike-0 with a documented fallback, and the git-hook vector D1
would confine is patched directly and cheaply.

### Open questions that MUST go to Nick at checkpoint 1

> **RESOLVED 2026-08-08.** (1) **Stronger isolation** — split-harness (D3)
> ratified. (2) **Accepted**: alpha = 3 personally-trusted users, shared-key
> spend cap **$100/mo**; allowlist emails + SMTP sender still to be supplied
> before go-live. (3) **One `bigbrain` box-user**; per-tenant uids deferred.
> (4) **Own VPS + Caddy + `bigbrain.cool`**, not exe.dev (see revised Fork F);
> signups **allowlisted**. The questions below are kept for the rationale
> record.

Genuine his-call items — risk-appetite and scope, which reasoning can't settle.
Everything else in this doc is decided. Each is set up in plain terms below; the
"D1/D3" shorthand maps to §2 (D3 = split-harness, D1 = minimal-diff).

1. **How hard do we isolate a tenant's AI pass?** When a hosted pass runs Claude
   over a tenant's vault it reads that tenant's notes, and a note can be poisoned
   (a malicious clip, or an attacker's item slipped in via email forwarding)
   with instructions like "read the other tenants' vaults and email them out" or
   "exfiltrate the API key." Two designs wall that off:
   - *Cheaper (D1, ~325 engine LOC):* run Claude as a normal box process; block
     it with a firewall rule + a per-tenant Unix user. Weakness: the wall is a
     *rule that must stay applied* — a reboot that misses reapplying it drops the
     wall silently; you learn about it from a leak. Also bets on an unverified
     pi custom-baseUrl behavior.
   - *Stronger (D3, ~650–900 engine LOC — recommended):* split the agent. The
     thinking half (talks to Claude, holds the key in memory) runs trusted on
     the box; every *action* (read/write/edit/bash) runs in a throwaway Docker
     container with **only that one vault mounted and the network physically off
     (`--network none`)**. "Read Bob's vault" fails (not mounted), "email it
     out" fails (no network), "steal the key" fails (never in the container).
     Isolation is structural, not a policy that can be misconfigured. Cost: the
     host↔container tool bridge is the biggest build unknown — fenced as
     Spike-0 (a contract test) with a documented weaker fallback.
   - Reviewer split: implementer → D1 (less code); operator + attacker → D3
     (its risk fails **loudly pre-deploy** via a test, vs D1's **silent
     post-deploy** firewall gap). **Ratify D3, or take D1's smaller-but-fail-
     silent isolation?**

2. **Two alpha shortcuts, and a dollar cap.** Both are only acceptable while
   alpha users are personally trusted:
   - *(a) One shared Anthropic key for all tenants* (proper per-tenant keys are
     #70). Because of Q1 the key never enters the container, so a poisoned run
     can't steal it or read other tenants' data — the only harm it can do is
     **burn your Claude bill**, bounded by the cap + a circuit breaker.
   - *(b) Docker runs as root.* A container escape (uncommon, not impossible)
     would be root on the box, reaching every tenant. `--read-only` /
     `--network none` / `--pids-limit` / no-socket shrink it; rootless Docker or
     a VM sandbox (Gondolin) is the deferred full fix.
   - **Is the alpha population small/trusted enough to accept both? What dollar
     figure is the shared-key spend cap? Who's on the invite/SMTP allowlist?**
     (Suggested cap: ~$100/mo.)

3. **One box user, or one per tenant?** In D3 the *container mount* is the real
   data wall. A per-tenant Unix user adds a second wall but costs real ops (N
   accounts, linger configs, PATH hazards). The one concrete thing separate
   users would guard — a poisoned note arming a git hook that later runs as the
   shared user — is instead patched directly and cheaply (git hooks disabled on
   the hosted path). Recommended: one `bigbrain` user + the git-hook patch, uids
   as named later hardening. **Accept the shared user, or provision per-tenant
   uids now?**

4. **Unlock the public edge for `bigbrain.exe.xyz`.** *(Updated 2026-08-08
   after an empirical probe.)* The edge currently 307-redirects anonymous
   traffic to exe.dev login; cache-guitar serves `/v1/health` publicly with no
   redirect — so this is per-VM exe.dev config, and the flip is Nick's to make.
   **Flip bigbrain.exe.xyz to public-forward (recommended; tell Workflow 2 the
   forwarded port), or plan Caddy + Let's Encrypt instead?** Note: Caddy today
   is awkward (Let's Encrypt needs domain control and `exe.xyz` is theirs);
   Caddy pairs naturally with the own-domain decision at launch, which is a
   separate, later host/domain call gated — like #70 — on signup opening
   beyond personally-known alphas. exe.dev is fine for the skeleton; it is
   likely not the launch host (dev-VM product, no SLA, shared 2-CPU/8G pool,
   25G disk vs unbounded blobs, and a product needs its own domain anyway).
