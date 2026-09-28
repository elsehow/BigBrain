# Hosted walking skeleton (#44) — plan of record

> **RETIRED 2026-08-26 with the hosted product (#566).** The code this describes lives at tag `hosted-multitenant-final`; nothing here describes the current engine.

Date: 2026-08-07 · Status: **plan** (design done — see
`2026-08-07-hosted-walking-skeleton-design.md` for the fork resolutions,
run-environment contract, tenant API, and work breakdown) · Owner: Nick + Claude
Issues: #44 (this slice) · #37 (isolation) · #39 (extension signup) · #40
(model phasing) · #41 (billing) · #46 (arrival envelope) · #70 (per-tenant
model credentials)

## The slice (from #44)

Smallest end-to-end hosted path, validated with curl, no UI:

1. Sign up against a real backend (bare page is fine)
2. Signup provisions a tenant vault server-side (bare repo + vault.yaml from
   template)
3. Authenticated `POST /drop` — the hosted twin of `bigbrain drop`
4. Editor pass runs server-side against that vault on arrival
5. Read the result (`GET` of raw files is enough)

Success = curl a clip in, watch it get filed and linked, read it back.
No extension, no billing, no MCP, no design work.

## Fixed decisions (settled 2026-08-07, do not re-litigate in design)

1. **Agent harness = pi** (github.com/earendil-works/pi: pi-coding-agent /
   pi-agent-core / pi-ai). Hosted editor/memory passes stop shelling out to
   `claude -p`; the swap point is the `ClaudeExec` seam in
   `lib/editor/run.ts`. Everything around the seam (prompt assembly, lock,
   debounce, queue, journal) is execution-agnostic and stays. Interactive
   Claude Code (laptop sessions, vault skills) is untouched — this is about
   hosted passes only. Consequences: no CLI/keychain dependency on the host;
   per-run explicit tool allowlists (this IS #37's capability-scoping
   mechanism); per-run model + credential injection via pi-ai (#40's
   plumbing).
2. **Signup/auth = Better Auth, control-plane only. "Sign in with Google"**
   (Better Auth Google social provider) — REVISED 2026-08-08 from email OTP.
   Rationale: OTP was chosen only to dodge one-time Google OAuth setup back
   when no domain was fixed; owning `bigbrain.cool` removes that blocker, and
   Google-login removes email delivery entirely (no SMTP/deliverability to
   operate — the "least ongoing thought" path Nick asked for), while matching
   #39's extension direction. One-time cost: a Google OAuth client (ID+secret,
   redirect `https://bigbrain.cool/api/auth/callback/google`); the secret is a
   paste-to-box secret. Sessions + tenant registry in one control-plane SQLite.
   Signups **allowlist-gated** on the verified Google email (just
   `alpha@example.com` for the alpha). **The engine never imports Better
   Auth**: it consumes identity *assertions* at the existing webgate/token
   seam (`lib/webgate.ts` — "login is identity + routing, not authz threaded
   through the vault", per deploy/AUTH.md). Self-host single-user requires
   zero auth setup, forever; multi-user self-host later rides the same
   assertion seam (own the auth module or bring a header-injecting proxy).
3. **Tenancy = per-tenant isolated instance** (deploy/AUTH.md Shape 1, the
   Ghost model). Shared-process multi-tenancy is rejected — reinforced by
   `lib/manifest.ts` resolving `VAULT_ROOT` at import time.
4. **Model credentials: one service-wide Anthropic key for the skeleton** —
   spend-capped, injected per-run into the run environment, never written
   into any vault tree. This is a **named deviation** from #37's
   tenant-scoped-credential rule; #70 is the graduation path
   (workspace-per-tenant keys via the Admin API) and must land before signup
   opens beyond personally-known alphas. The run-environment contract records
   the deviation and cites #70.
5. **Secrets flow**: agents mint generated secrets directly on the box
   (values never transit agent context); Nick pastes issued secrets
   (Anthropic key, SMTP) via `! ssh <box> 'umask 077; cat >>
   ~/.config/s-tier/secrets.env'`. No cloud secret manager at this scale;
   revisit at rung-1 BYOK (encrypted-at-rest per-tenant creds in the control
   plane).

## Open forks (the design phase must answer each)

- **pi containment**: Gondolin (VM, Earendil's own) vs Docker vs bare
  process for pass runs. pi has no built-in permission system; containment
  is the #37 enforcement mechanism.
- **Pass scheduling**: per-tenant timers (systemd) vs one shared sweep vs
  reopening a hosted-role poke-on-arrival. Note: arrivals deliberately do
  NOT poke the editor today (60s tick + debounce); the demo "aha" and #40's
  hook phase want a fast first filing.
- **Disk layout**: where tenant repos, blobs (`.blobs/` CAS), control-plane
  state, and per-tenant token stores live on the box.
- **Identity assertion contract**: exact shape (configurable trusted-header
  vs signed assertion) that the control plane, exe.dev edge, future
  extension flow (#39), and self-host proxies all ride through.
- **Control-plane package boundary** (and licensing posture — default AGPL
  like everything, per business model v1.2).
- **Edge routing + port allocation** for per-tenant instances (what fronts
  them — Caddy? — and how a request finds its tenant).
- **Arrival latency budget**: what "pass runs on arrival" means in seconds,
  and what mechanism delivers it.

## Deploy target — RESOLVED at checkpoint 1 (2026-08-08)

**A dedicated VPS + Caddy + `bigbrain.cool` — not exe.dev.**
*(Box live 2026-08-08: Ubuntu 26.04, 4 vCPU, 7.6 GiB, no docker/bun yet —
bootstrap installs them; `bigbrain.cool` + `www` A-records resolve to it; ssh
root key works.)* Nick owns `bigbrain.cool` and wants the product on it;
exe.dev's per-VM public-forward is uncertain and its edge is `.exe.xyz`-locked. So the skeleton ships on a
standard Linux VPS (root, systemd, rootful Docker, full nftables control —
all of which the split-harness needs and a managed edge may not give),
fronted by Caddy terminating Let's Encrypt TLS for `bigbrain.cool` → router
`127.0.0.1:4700`. This **collapses the launch-host migration**: we start on
the real host + real domain instead of moving later. The already-provisioned
`bigbrain.exe.xyz` box is retired from this plan (kept only as scratch).

**Signups are allowlisted** (hard requirement, Nick): after Google
authenticates a user, the verified email must be on the invite allowlist —
just `alpha@example.com` for the alpha. This is the same gate v1.2/v1.3 named ("charge/admit the
alpha cohort from day one") and closes the open-inbound-signup risk until #70.

Box class: ~4 vCPU / 8 GB / 80+ GB (matches the design's memory assumptions
and gives blob headroom over the old 25 GB). Deploy pattern unchanged: push
GitHub → `git pull --ff-only` on box → `bigbrain install` + control-plane
units; verify over HTTP, never `systemctl --user` over bare ssh.

**Checkpoint-1 answers (2026-08-08):** (1) stronger isolation — split-harness
ratified; (2) alpha = 3 trusted users, shared-key spend cap **$100/mo**;
(3) one `bigbrain` box-user, per-tenant uids deferred; (4) host as above.

## Process

- **Workflow 1 — Design** (~12 agents): 5 readers (auth/web seam;
  provisioning; runtime path; testing/verify; pi SDK) → 3 architects with
  different priors (minimal-diff / queue-centric / contract-first) → 3
  judges (criteria: smallest-diff-to-working-curl, sets-up-#39/#40/#37,
  solo-operator ops burden, isolation soundness) → 1 synthesizer producing
  the design doc + run-environment contract draft + tenant API shape
  (respecting #46's envelope fields).
- **Checkpoint 1 — Nick**: rule on the forks; approve the design doc.
- **Workflow 2 — Implement** (~10 agents, git worktrees, one PR): control
  plane (Better Auth + SQLite registry + signup-provisions via
  `bin/init.ts`), edge router + port allocation, pi-backed runner behind
  `ClaudeExec`, session→drop-token wiring, sandbox e2e per the house test
  pattern. Gates: `bun test` green, `oxlint` silent. Nick reviews the PR.
- **Checkpoint 2 — Nick**: merge; paste issued secrets; agent drives
  deploy.
- **Workflow 3 — Verify** (~12 agents): live e2e (tenant A files a curl'd
  clip; tenant B proves isolation; negative auth tests) + adversarial
  review lenses (correctness, #37 threat model, auth/session, ops failure
  modes) with independent refutation per finding; fix loop.
- **After**: real-browser signup test; contract feeds #37; file the #35
  follow-up (multi-user trigger fired); update AUTH.md deferred list;
  comment outcome on #44.

## References

- deploy/AUTH.md (tenancy design + evolution path), deploy/HTTP.md (intake
  contract), docs/design-principles.md, docs/plans/2026-08-03-drop-zone-
  bigbrain.md, .claude/skills/verify/SKILL.md
