# Offsite backup for the hosted box (#35)

> **RETIRED 2026-08-26 with the hosted product (#566).** The hosted box this plan backs up is gone; code at tag `hosted-multitenant-final`.

2026-08-09. #35 was surveyed against the single-user host and deliberately
deferred ("we can deal with this when we create a multi-user app"). That app
exists now: bigbrain.cool holds tenant vaults — git records, the `.blobs/`
CAS (every PDF's original bytes), token stores — plus the control-plane
registry, all single-copy on one Hetzner root disk. This lands BEFORE alpha
invites go out.

## Decision: restic → Hetzner Storage Box, run as root, hourly

- **Tool: restic.** Single binary (apt), encrypted-by-default repos,
  content-addressed dedup that matches the CAS's add-only layout, sftp
  backend needs no cloud account. Snapshot-prune-check are one tool.
- **Destination: a Hetzner Storage Box** (BX11, 1TB ~ €4/mo) — same provider
  account Nick already has, sftp/ssh access, no new credential ecosystem.
  S3/B2 would add a provider signup for no durability we need at this scale;
  rsync-to-cache-guitar would chain the product's durability to a home
  server. The repo URL/user land in `backup.env`; nothing else changes if
  the destination ever moves.
- **Run as root** (system timer, not `--user`): sidesteps the uid-10001
  nftables egress jail (443-only — sftp rides 22/23) and means a compromised
  tenant-uid process can neither read the repo password nor touch the
  offsite copy. The repo password file is root:root 0600.
- **Hourly** `backup` + `forget --prune` (keep 24 hourly / 7 daily /
  4 weekly / 6 monthly); **weekly** `check --read-data-subset=5%` actually
  re-reads repo data — a backup that is never read back is a hope.

## What is covered

- `/srv/bigbrain/tenants/` — every vault: git record, `.blobs/` CAS,
  `tokens.json`, `tenant.env`. Excluded: `tenants/*/run/` (container
  scratch, recreated on demand).
- `/srv/bigbrain/control/data/` — including a point-in-time
  `control.db.backup` taken each run via sqlite's online-backup API
  (python3), so the restored registry is consistent even if the live db was
  mid-write.

## What is deliberately NOT covered

- **`secrets.env` stays on the box.** Every secret in it is re-mintable
  (OAuth client, admin key, pool keys via Console) — shipping it offsite
  adds risk, not durability. Consequence: a from-scratch restore re-pastes
  secrets, and pool-key envelopes in the restored registry are dead without
  the old `S_TIER_KEY_MASTER` — acceptable, keys re-mint in minutes.
- **The restic password is escrowed in Nick's password manager**, fetched by
  him directly off the box (never through a transcript). If the box dies,
  that password + the storage box IS the vault estate. This is the one
  non-negotiable human step.
- **Crash consistency, not application consistency**: a snapshot taken
  mid-editor-run may catch a transient queue file. Git + the add-only CAS
  make this benign; the sqlite backup API covers the one file where torn
  writes would actually hurt.
- **The personal vault host (cache-guitar) is out of scope here** — same
  mechanism, second repo, when wanted. #35's original single-user exposure
  note stays true there.

## Pieces

- `control/deploy/backup.sh` — `run` / `check` / `status`; reads
  `~bigbrain/.config/s-tier/backup.env` (repo URL + ssh alias), password
  from `restic.pass` (bootstrap-generated). NOT CONFIGURED ⇒ exit 0 with a
  log line, so the timers are enabled unconditionally and go live the
  moment backup.env appears. First configured run auto-`restic init`s.
  Every run tattles when the root disk passes 85% (the issue's headroom
  requirement) — visible in `journalctl -u s-tier-backup`.
- `s-tier-backup.{service,timer}` (hourly), `s-tier-backup-check.{service,timer}`
  (weekly) — system units, `Persistent=true`.
- `bootstrap.sh` — installs restic, generates `restic.pass` + a dedicated
  ed25519 keypair for the storage box (prints only the pubkey), installs +
  enables the timers.
- `bb-backup` shim → `backup.sh status` for the operator.

## Provisioning (the human half, ~5 min)

1. Nick orders the Storage Box in the Hetzner console, enables ssh, and
   adds the printed public key.
2. Operator writes `backup.env` (repo URL) and the `/root/.ssh/config`
   host block; the next timer tick inits the repo and takes snapshot #1.
3. Nick escrows `restic.pass` into his password manager.
4. Verify: `bb-backup status`, then a restore drill of one tenant into
   /tmp (README documents the exact commands).
