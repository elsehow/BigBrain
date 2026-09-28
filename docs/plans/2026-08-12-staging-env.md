# Staging environment (before alpha invites)

> **RETIRED 2026-08-26 with the hosted product (#566).** There is no staging box, no deploy.sh, no bigbrain.cool deploy target any more; code at tag `hosted-multitenant-final`.

2026-08-12. The alpha deploy makes bigbrain.cool "prod": real vaults, real
spend, a deploy runbook whose only test environment is production itself.
This plan adds a staging box FIRST — while a botched deploy still costs
nothing — and hardens the deploy path so the wrong box is hard to hit by
accident. Same reasoning as the backup plan (2026-08-09-blob-backup.md):
land it before invites go out.

## Decision: a second box, same bootstrap, domain templated

**`staging.bigbrain.cool` on its own small Hetzner VPS (CX22-class),
stood up by the same `control/deploy/bootstrap.sh`.**

- `bootstrap.sh` is idempotent and IS the environment definition, so a
  second box is ~free and cannot drift from prod by construction. The
  same-box alternative (second instance under another user) fights
  load-bearing invariants — uid-10001 alignment, `/srv/bigbrain` paths in
  units and shims, one Caddy vhost, per-uid nftables egress — and couples
  staging experiments to the box real users are on.
- Staging's job is what only the hosted topology exercises: OAuth,
  signup → provisioning, the warden, per-tenant units, quotas, the
  extension relay. Local dev (workbench, /verify sandbox vault) already
  covers everything else.
- The engine change is small because `control/config.ts` already reads
  `CONTROL_BASE_URL`: template `{{DOMAIN}}` into the Caddyfile and the
  control unit (rendered by bootstrap like `{{ENGINE}}`), add
  `DOMAIN="${DOMAIN:-bigbrain.cool}"` as a bootstrap knob, and make the
  `www` redirect block prod-only (no `www.staging` DNS will exist; Caddy
  must not chase a cert for it). Staging deploy becomes:
  `ssh root@staging.bigbrain.cool 'DOMAIN=staging.bigbrain.cool bash -s' < control/deploy/bootstrap.sh`.

## Same format, disjoint data

Staging and prod share the vault FORMAT (both run engine `main`; staging
just gets it first). They never share vault DATA:

- Each box has its own `/srv/bigbrain/tenants`. Prod vaults never come
  down to staging — staging is where unproven code runs, and vaults are
  bind-mounted rw into every pass container; a staging bug that corrupts
  a real vault is a prod incident with less discipline around it. Seed
  staging through the front door (signup + the success loop), never by
  copying.
- **One long-lived canary tenant** on staging, never wiped. Fresh
  synthetic vaults only ever test the current format; the vault with
  months of old-format content in it is what catches a compat break.
  Start it now so it has age by the time it matters.
- No offsite backup on staging (`backup.env` unwritten → timers no-op).
  Staging data is disposable; that is the point.

### The no-migration policy, made enforceable

We avoid migrating user vaults at all costs. Two rules make that a
review-time property instead of a hope (add both to
`docs/design-principles.md` when the staging PR lands):

1. **Vault-format changes are additive and tolerant-read.** New dirs and
   optional `vault.yaml` keys are fine; the engine treats absence as
   default. A PR that requires existing vaults to change shape is
   rejected on that ground. Generated files (CLAUDE.md, `.claude/`,
   `.gitignore`) are re-rendered idempotently and are not migration
   surface.
2. **The lake envelope + queue history are the never-break surface.** If
   a breaking vault-structure change ever becomes unavoidable, the
   escape hatch is re-derivation, not migration: the vault is a pure
   derived view (design principle 1), so replaying the queue over the
   lake rebuilds it in the new shape — model spend, not hand-migration.
   That only works while the envelope and queue formats stay stable.
   Staging is where a replay gets proven before any real vault depends
   on it.

## Promotion flow

Both boxes track `main`. Merge PR → deploy staging → verify → deploy
prod, always in that order:

```
deploy staging          # wrapper, below
curl -fsS https://staging.bigbrain.cool/healthz
# success loop on staging: sign in, drop a clip, watch it absorb
deploy prod             # prompts; requires typing "prod"
```

Deferred until it earns its keep: pinning prod to a `release` branch
fast-forwarded after staging checks out. With deploys this deliberate,
"staging first" as discipline is enough for the alpha.

## Guardrails: make the wrong box hard to hit

The failure to design against: an agent (or a tired human) runs the
deploy one-liner against prod when it meant staging. Three layers, all
free:

1. **One blessed deploy path.** `control/deploy/deploy.sh <staging|prod>`
   wraps the ssh one-liner: names its target, refuses bare invocation,
   and for prod requires interactive confirmation (type `prod`) or an
   explicit `--yes` that no doc ever shows. Runbook and CLAUDE.md teach
   ONLY the wrapper; the raw `ssh root@… bash -s` form leaves the docs.
2. **Key separation with a human gate on prod.** Staging's root key is
   passphrase-free (agents may deploy staging unattended). Prod's root
   key is passphrase-protected — or lives in 1Password's SSH agent with
   per-use approval — so touching prod requires Nick's hands once per
   deploy. This is the layer that holds even when layer 1 is bypassed.
3. **CI green before any deploy.** GitHub Actions on every PR:
   `bun test`, `bun run lint`, svelte-check, `bun run web:build` (the
   build IS a deploy step — a broken build should fail a PR, not the
   box). Free tier: 2,000 min/mo on private repos, plenty at our scale.

**Plan constraint, verified 2026-08-12:** the repo is private on GitHub
Free — branch protection and rulesets return 403 ("Upgrade to GitHub Pro
or make this repository public"). So `main` cannot be *enforced*
PR-only; CI + discipline stand in. GitHub Pro (~$4/mo) is the single
cheapest upgrade if we ever want required reviews + required status
checks on `main`, and would also unlock environment protection rules
(deploy-to-prod approval buttons) if deploys later move into Actions.
Not needed for the alpha.

## Work items

- [x] Engine PR: `{{DOMAIN}}` templating (Caddyfile, control unit),
      `DOMAIN` knob in bootstrap, prod-only `www` block, `deploy.sh`
      wrapper, CI workflow; docs: runbook + CLAUDE.md go two-host,
      design-principles gains the two no-migration rules. (This PR.)
- [x] Order the staging VPS; Porkbun A record `staging.bigbrain.cool`.
      (89.167.3.80, live 2026-08-12.)
- [x] Staging Google OAuth client (redirect
      `https://staging.bigbrain.cool/api/auth/callback/google`) — its own
      client, so prod credentials never sit on the staging box.
- [x] Staging Anthropic key in its own workspace with a LOW spend limit —
      a staging bug can't burn prod budget, and Console spend separates
      staging cost from tenant COGS.
- [x] New read-only deploy key minted on the staging box, added to the
      repo (a repo can hold several).
- [x] Bootstrap staging with the `DOMAIN` override; checkpoint-2 secret
      paste (staging OAuth client + staging Anthropic key). (First boot
      note: bootstrap does NOT mint the deploy key — generate it on the
      box and register it before the engine-clone step can pass.)
- [x] Verify: `/healthz` green 2026-08-12; success loop in progress.
- [x] Create the canary tenant: **`t_0f013d9b`** (Nick's own staging
      signup, 2026-08-12). Never wipe it.
- [x] Prod root key is now the dedicated passphrase-protected
      the passphrase-protected prod key — the ONLY key prod accepts (old key removed
      2026-08-12; backup `authorized_keys.bak-20260812` on the box).
      Staging deploys confirmed unattended.
- [ ] Allowlist on staging: Nick ✓ (default); throwaway test Google
      account still to add via
      `ssh root@staging.bigbrain.cool 'bb-invite add <addr>'`.
- [x] Agent memory: "one host" fact retired 2026-08-12.

## What staging is NOT

- Not a second prod: no backups, no uptime promise, no real users.
- Not a data mirror: prod vaults never leave prod.
- Not a substitute for local dev: the workbench and /verify sandbox
  remain the inner loop; staging is the last gate before real vaults.
