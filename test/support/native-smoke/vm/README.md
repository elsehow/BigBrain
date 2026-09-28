# Disposable native-smoke VM

Status: **run end to end on 2026-09-26** against the 0.7.28 consent/feedback
candidate. One offline clone of a clean macOS base booted, passed 19/19 in-guest
containment checks before BigBrain's first start, and ran the unchanged packaged
app through first run, consent choice, two native restarts, Settings withdrawal,
blocked feedback with retry, window interaction and quit. Results and evidence
are under "Run of 2026-09-26" below.

The user authorized a disposable **local** VM and repeatable automation. The
restrictions on host profiles, credentials, publishing, PostHog ingestion, paid
services and host security changes still apply.

## Pieces

| Piece | Role |
| --- | --- |
| `driver/bbvm.swift` (`build.sh`) | Minimal Virtualization.framework host. `create` installs macOS from an Apple IPSW; `run` boots a bundle, shows it in its own window and serves a control socket (state, screenshot, click, drag, key, type, stop). Refuses any NIC unless `--allow-network`. Ad-hoc signed with the virtualization entitlement; no Apple Developer account. |
| `driver/vmctl.py` | Socket client; logs every command to `$BBVM_LOG` so a run can be replayed. |
| `runner.py` | Host-side guard rails: `preflight`, `candidate`, `transfer`, `check-vm`, `clone`, `boot`, `export`, `cleanup`. |
| `guest/containment.sh` | In-guest evidence before BigBrain first runs; exits 1 on any FAIL. |
| `guest/launch.command` | Refuses unless VirtualMac + no link/route/shared FS; verifies the full artifact inventory; copies the app to `~/Applications`; installs the disclosed provider stub; execs the unchanged app with a scrubbed environment. |
| `guest/collect.sh` | Copies evidence, consent state and logs to the per-run output disk. |
| `candidate.json` | The reviewed lock (version, BUNDLE, executable hash). |

The driver, not UTM, runs every VM. It reads and writes UTM's schema-4
`config.plist` so bundles stay UTM-openable, but it never talks to UTM: Apple
Events or Accessibility grants would attach to the host's BigBrain app (this
process tree's TCC-responsible process). Input is injected into the driver's own
`VZVirtualMachineView` and screenshots are of its own view, so no host TCC grant
is needed.

## Base (one time per OS target)

```sh
sh test/support/native-smoke/vm/driver/build.sh .tmp/native-vm/tools/bbvm
.tmp/native-vm/tools/bbvm create STORAGE/bb-base-macos-26.6.2-25G83.utm \
  --ipsw STORAGE/UniversalMac_26.6.2_25G83_Restore.ipsw --network   # ~15 min, headless
.tmp/native-vm/tools/bbvm run STORAGE/bb-base-….utm --control /tmp/bbvm-base/control.sock \
  --status STORAGE/base-status.json --allow-network
```

Then, **by a human** in the driver window: Setup Assistant (local account
`bigbrain`/`bigbrain`, decline Apple Account, iCloud, Siri, analytics, location,
screen time), and the Command Line Tools (`xcode-select --install`, or the user's
own Xcode install). `lib/preflight.ts` hard-fails without `git`, so the base
must have them. In the guest Terminal: `sudo pmset -a sleep 0 displaysleep 0
disksleep 0`. `sudo shutdown -h now`, then strip the network and check:

```sh
plutil -replace Network -json '[]' STORAGE/bb-base-….utm/config.plist
python3 test/support/native-smoke/vm/runner.py check-vm STORAGE/bb-base-….utm
```

Keep the base powered off from then on. It never holds a candidate.

Current base: macOS 26.6.2 (25G83) from the SHA-verified Apple IPSW
(`artifacts/native-vm/restore-image.sha256`), 4 CPU / 6 GiB / 64 GiB sparse disk,
30 GiB on the host, 12 GiB used in the guest, CLT at
`/Library/Developer/CommandLineTools` (git 2.50.1), FileVault off, no autologin.
Config SHA-256 after stripping the NIC:
`badedd495ecad0777604ee6c25f5d6fff47fd524a4c6963589b32b43b7cfca1c`
(`artifacts/native-vm/base-vm.json`).

## Per run

```sh
R=test/support/native-smoke/vm/runner.py
python3 $R transfer '/path/to/BigBrain Consent Review.app' STORAGE       # ~30 s; verifies inventory vs lock
python3 $R clone STORAGE/bb-base-….utm STORAGE --transfer STORAGE/bb-transfer-ID/transfer.json   # ~7 s
python3 $R boot STORAGE/bb-smoke-ID.utm.receipt.json --driver .tmp/native-vm/tools/bbvm   # prints the socket
```

`clone` is an APFS `cp -cR` (no full-copy fallback), a fresh VM UUID, the
transfer image converted to raw (`hdiutil convert -format UDTO`, because
Virtualization.framework attaches only raw/ASIF images) and attached
`ReadOnly=true`, plus a blank 2 GiB HFS+ output disk. `boot` never passes
`--allow-network`; the driver refuses any config with a NIC. The control
socket lives in `/tmp/bbvm-*/` because a worktree-deep path overflows
`sun_path`.

In the guest (driven through `vmctl.py`, or by hand in the driver window):

1. Log in (`bigbrain`).
2. Terminal: `/Volumes/BB_SMOKE_INPUT/containment.sh /Volumes/BB_SMOKE_OUT/evidence/containment`
   — must print 19 PASS and exit 0 **before** anything else.
3. `/Volumes/BB_SMOKE_INPUT/launch.command` — this window then belongs to the
   app; open a second Terminal window for inspection, and never type into the
   first (the text waits in its tty and runs when the app quits).
4. Walk the scenarios (below), snapshotting `~/.config/bigbrain` to the output
   disk between steps.
5. Quit, `/Volumes/BB_SMOKE_INPUT/collect.sh`, `sudo shutdown -h now`.

```sh
python3 $R export STORAGE/bb-smoke-ID.utm.receipt.json artifacts/native-vm/run-N-ID
python3 $R cleanup STORAGE/bb-smoke-ID.utm.receipt.json
```

`export` mounts the output image read-only/nobrowse on the host and copies only
its `evidence/` tree. `cleanup` removes only the receipt's generated clone and
keeps the base, receipt and run logs.

### What is unattended and what needs a human

- Unattended: transfer, clone, boot, containment, export, cleanup, and all
  guest input/screenshots through the socket. Every step of run 2 was driven
  from the host this way.
- Judgment, currently by the agent or a person reading screenshots: where to
  click in the app (coordinates are not stable across UI changes) and whether
  each screen is right. A scripted scenario would need stable selectors; the
  debug build's Web Inspector is the obvious hook, not yet used.
- A human, once per base: Setup Assistant and the CLT install.
- Guest-only TCC prompt: the first vault creation under `~/Documents` asks to
  let Terminal (launch.command's responsible process) access Documents; allow
  it inside the guest.

## Run of 2026-09-26

Candidate: source `a5be940c3a11cd22c2cf59844a6de5f6bbf287a7`, version 0.7.28,
BUNDLE `engine db5dc5a6, built 2026-09-25T21:40:57Z`, executable
`2e5bea9576845d396c494fcb871186e4357b1384fae92d9a3b8edb98c7f68c00`, inventory
`d650afc6fdcc2e47c2695f96b838bcf7ee99bbb1ca094fc6bb3251e5dac5bb8a`
(23,747 entries, verified inside the guest for both the input volume and the
copied app). Transfer image `e6d4a092…fb559` (`artifacts/native-vm/transfer-result-4.json`).

Run 1 (`run-1-a8f769ce`) stopped at containment: three false FAILs (`route get`
exits 0 on "not in table"; a NIC-less VZ guest has an inactive, address-less
`en1` paired with `anpi0`; `utun` tunnels carry scoped link-local IPv6
defaults). The checks and `launch.command` now read what those tools say.
Run 2 (`run-2-04b47276`) is the smoke:

| Scenario | Result | Evidence (under `artifacts/native-vm/run-2-04b47276/`) |
| --- | --- | --- |
| Containment before first start | 19/19 PASS: VirtualMac, no linked en*, no v4/v6 route, TEST-NET-1 unreachable, loopback canary delivered, input read-only, no profile state, CLT present | `guest/containment/` |
| First-run window, vault creation, handover | Onboarding (5 steps) → vault at `~/Documents/SmokeVault` → main view on the empty vault | `host/shots/launch-000…step2-003`, `after-optout-*`, `rclick-001` |
| Synthetic onboarding | Claude "Connected" via the stub (`native-smoke@example.invalid`); clients and integrations skipped | `step2-004`, `step3-001`, `step4-*` |
| Analytics default off | No `telemetry.json` before the choice | `guest/states/01-before-consent-choice` |
| Explicit opt-out, persisted across native restart | "No thanks" → `{"enabled":false}`; after quit + relaunch: no re-prompt, Settings off | `states/02`, `states/03`, `relaunch1-diag` |
| Opt-in, persisted across native restart | Settings → `{"enabled":true,"id":…}` 0600; same id after quit + relaunch | `optin-*`, `states/04`, `states/05`, `relaunch2-diag` |
| Settings withdrawal | Unchecked → "Sharing is off", `{"enabled":false}`, id removed | `withdraw-001`, `withdraw-003`, `states/07` (see `NOTES.md` on `states/06`) |
| Feedback with analytics off | Sent while off; consent file unchanged by it | `fb-002`, `states/07` |
| Blocked delivery, retained draft, retry | "Could not send feedback. Check your connection and try again. Your draft is still here." + Try again; retry fails the same way; draft survives closing and reopening the dialog | `fb-003`, `fb-004`, `fb-007-closed`, `fb-008-reopened` |
| Native window interaction | Minimize/restore from Dock, full screen and back, red close hides the window (app keeps running) and Dock reopens it | `win-*` |
| Quit and owned-child cleanup | Tree app → supervisor (own pgid) → api/web, loopback listeners only; after each of three Cmd+Q: no app/bun process, no listener | `states/08`, `states/03`, `states/05`, `states/09`, `quit*-*`, `final-002` |
| Candidate identity in the app | Settings → This machine: engine `db5dc5a6`, built 2026-09-25T21:40:57Z; Diagnostics 0.7.28 | `optin-001`, `win-zoom` |

Instrumented or mocked: only the provider. `launch.command` installs a
disclosed `~/.local/bin/claude` stub answering `--version`, `auth status` and
the four plugin commands; the app and engine are byte-identical to the lock.
The stub is not the only Claude path: model discovery (`lib/claudeModels.ts`)
starts the Claude Agent SDK's embedded Claude Code, which wrote `~/.claude.json`
and queued its own first-party telemetry to `~/.claude/telemetry/` after failing
to send it offline (`guest/claude-state/`, `NOTES.md`). That is the user's
provider's telemetry, not BigBrain's, but a networked run would send it.
Discovery now sets `DISABLE_TELEMETRY=1`, so a run from this fix on should
find no `~/.claude/telemetry/`; `~/.claude.json` is Claude Code's config and
is still written.

Observed, not defects of the candidate: the updater's request to
`bigbrain.exe.xyz` fails at each launch (offline); the empty-vault main view
is blank until the pointer moves, which briefly looked like a failed handover.

Onboarding gap (recorded, not a blocker): with no CLT the engine's preflight
fails on `git --version`. This base has CLT, so this run could not show how the
first-run UI surfaces that; the user hit it by hand earlier. A clone of a
pre-CLT base would be needed to capture it.

Disk: base 30 GiB, IPSW 18 GiB, four transfer images ~1.1 GiB each (three
superseded, removable individually), a clone grows to a few GiB during a run and
is deleted by `cleanup`; host free 41 GiB after the run.
