# Packaged acceptance for #1009

Run on September 26 local time / September 27 UTC in a disposable offline
macOS 26.6.2 (25G83) Apple Virtualization VM. The unchanged packaged application
ran in its actual WKWebView. No application was launched on the host.

## Artifact and containment

Version **0.7.28**, source **849a0bbd42b0a9788f0f782dcbacacf313b689cf**,
BUNDLE `engine 849a0bbd`, built `2026-09-27T05:06:22Z`.
[Artifact verification](artifact.json) records the executable hash and full
22,845-entry inventory hash; both the read-only input and installed copy passed.
This is an ad-hoc signed local package, not a published/notarized release.

The powered-off clean base was APFS-cloned. The driver refused networking;
[all 19 containment checks passed](containment.txt) before first launch.
There were no shared host filesystems, host profiles, real accounts or credentials.
The input was read-only; guest evidence was exported before deleting the clone.
Output image SHA-256: `cd16700e244fb8e303293d30064769542fa0ab79808acb83ab8c843cbcaff0cb`.
Evidence file hashes are in [sha256.json](sha256.json).

## Observed results

| Scenario | Evidence and result |
| --- | --- |
| Missing git / #975 | Temporarily moved CLT inside the clone, then chose an empty folder using the native picker. [The UI displays the actionable remedy](10-remedy-persists.png) and retains it across repeated status polls. Restored CLT, chose the same folder, and the error cleared, creation succeeded, and the real supervisor handed over to the viewer. |
| First run | Entered fabricated identity `Native Smoke` / `native-smoke@example.invalid`, passed provider status, skipped clients and integrations, chose “No thanks” for analytics, reached the main app. Subsequent native restarts did not repeat onboarding. |
| Recovery after restart / #1017 | Seeded a persisted working turn and executing action while the app was stopped. Relaunch showed “Interrupted,” the unsent draft, and [distinct Confirmed / Outcome unknown action rows](29-recovery.png). Refresh retained the observations without starting work. [Public action response](actions-returned-a.json) confirms completed/uncertain states and no unreadable records. |
| A → B → A / #1011 | Two fabricated vaults have the exact same conversation and message IDs. [B showed only B's content and draft](35-b-content-draft.png). After editing separate drafts, [return to A restored A's content and edited draft](39-returned-a.png). [Durable A](durable-A.json) and [durable B](durable-B.json) retain the distinct unsent drafts. Neither was submitted. |
| Install / reinstall | The harness copied the locked package into guest Applications. After normal quit, moved that copy aside and ran the installer-copy path again. The newly verified app retained the selected vault, A's conversation and edited draft, and consent choice. |
| Offline update check | Each launch's normal updater request to `https://bigbrain.exe.xyz/latest.json` failed cleanly because the VM had no NIC. The app remained usable. This does **not** establish successful signed remote update, notarization, or release publication. |
| Shutdown | [Running tree](processes-running.txt) shows native app → supervisor in its own process group → viewer. Normal Cmd+Q terminated them; [final matching processes](processes-final.txt) and [listeners on 4747/4748](listeners-final.txt) are empty. |

The first candidate (`b03b0621`, same version) exposed a real defect: setup status
refresh erased the missing-git remedy. #1029 fixed it; the successful run above
uses that fix. This run also exposed an unplaced Action history button overlapping
the model label in the header. The accompanying layout change moves it into the
existing commands row; the maintained production-AppShell test checks non-overlap
at 390 and 1280 pixels. The earlier screenshots preserve the native finding. A fresh follow-up clone
verified the corrected package as described below.

## Reproduce

Use [the existing VM harness](../../../test/support/native-smoke/vm/README.md).
Build from `desktop/` with `bun run build --bundles app --config
'{"bundle":{"createUpdaterArtifacts":false}}'`; lock the actual version, BUNDLE,
and executable hash, then transfer, clone and boot. Do not run the candidate on
personal data. Complete the guest containment check before `launch.command`.

The transfer now includes `acceptance-fixture.sh`. It refuses non-VirtualMac hosts
and uses only `~/Documents/NativeVaultA` and `NativeVaultB`. The second path must
not exist when seeding; the app must be stopped. In the guest:

1. Create NativeVaultA through onboarding. For the missing-git case, first move
   `/Library/Developer/CommandLineTools` aside **in the clone only**, observe the
   remedy, restore it, then retry.
2. Run `/Volumes/BB_SMOKE_INPUT/acceptance-fixture.sh provider` and finish onboarding.
3. Quit normally. Run the fixture with `seed`; relaunch with `launch.command`.
4. Open the invented conversation, inspect/refresh its actions, edit its draft,
   switch to B through Settings → general → Open, edit B's draft, and return to A.
5. `inspect LABEL` saves public API responses. Quit, collect evidence, shut down,
   export, then clean up the generated clone with the runner.

Only provider status is synthetic: `BIGBRAIN_ANTHROPIC_CONNECTED=1` in the guest
vault, plus the existing disclosed CLI stub. No OAuth, model inference or external
integration was validated. Working turns and receipts are fabricated crash-state
inputs; the real engine performs recovery. No uncertain action is dispatched.
The automated suites separately cover delayed responses, multiple browser tabs,
namespace cleanup, delivery identities, corruption, and non-replay enforcement.

The run's extra fixture was staged into the read-only transfer before cloning,
and the transfer digest was regenerated. The maintained runner now includes that
same fixture directly. Full local evidence remains under
`/private/tmp/bigbrain-native-acceptance/run2/`; only the small relevant subset is
checked in here. The clean base is preserved, and all three smoke clones were removed.

## Final-layout native follow-up

A fresh offline clone passed all [19 containment checks](containment-final.txt)
and verified [the corrected artifact](artifact-final.json): source
`d6e90331bc82295bdf76d296d8a003cbe1ca14d6`, version 0.7.28, BUNDLE
`engine d6e90331`, built `2026-09-27T05:44:30Z`. The unchanged package now shows
[the model aligned beneath the title and a separate Action history control](10-fixed-header.png).
Clicking that header control [opens the confirmed/unknown recovery view](11-header-opens-recovery.png).
The local draft remains visible and unsent. Normal quit again leaves no matching
app/engine process or listener on 4747/4748. The clone was exported and deleted.
Output image SHA-256: `0daaa41ec8f51fbadff6cfa596e0eca9479942a98390f4724fc42a80498a357e`.

This focused follow-up prepared the fabricated vault, identity, consent-off choice,
and completed setup through the real guest setup API, then used the maintained
provider/seed fixture while the app was stopped. It supplements the full UI-driven
first run above; it is not a second claim of walking every onboarding control.
Full follow-up evidence is under `/private/tmp/bigbrain-native-acceptance/run3/`.
