# Native packaged-smoke isolation investigation — 2026-09-25

**Update 2026-09-26: the native smoke ran, in a disposable offline macOS VM.**
The in-place host containment investigated below failed, so the user authorized
a local VM instead. A clean macOS 26.6.2 base built with the repo's own
Virtualization.framework driver, cloned per run with no network device, passed
19/19 in-guest containment checks before BigBrain's first start, then ran the
unchanged 0.7.28 package (`a5be940c`, executable `2e5bea95…`) through first
run, consent default/opt-out/opt-in/withdrawal across two native restarts,
blocked feedback with retained draft and retry, window interaction, and quit
with no surviving children. Runbook, results and evidence paths:
[test/support/native-smoke/vm/README.md](../test/support/native-smoke/vm/README.md).

Everything below is the original host investigation, kept as the record of
why a VM was needed. Its "remains blocked" conclusions are historical.
The focused change is a reproducible, fail-closed test harness; no production
code, defaults, security policy, feature, CI registration, package, or installed
application was changed. Failed containment checks are not candidate defects.

## Provenance

Fetched `origin/main` before creating isolated branch/worktree
`codex-native-smoke-isolation` at
`3881557b93e4173dfa2ed981d23a6854d5d98edf`. Only the harness and this report diverge
from that baseline. The installed app's read-only BUNDLE inspection reports
`565de2ec`, built `2026-09-25T15:48:03Z`; it was neither launched nor replaced.
There is no whole-app preview from this worker.

The other worker's stable refreshed candidate is `a5be940c` (evidence-only after
implementation/CI `db5dc5a65bee65be77d7a54eecfa2a3dc1390723`), version **0.7.28**,
in `.claude/worktrees/codex-feedback-consent-refresh`. Read-only checks confirmed:

- Unsigned package:
  `desktop/src-tauri/target/debug/bundle/macos/BigBrain Consent Review.app` there.
- BUNDLE: `engine db5dc5a6`, built `2026-09-25T21:40:57Z`.
- Native executable SHA-256:
  `2e5bea9576845d396c494fcb871186e4357b1384fae92d9a3b8edb98c7f68c00`.
- Bundled Bun SHA-256:
  `cec3f87f0e17c12a294c75216bc7a08088e13b0be46623f65d5802ac56276bb1`.

No stale `ad9fb05e` package was used. No package was rebuilt: the safety gate
failed before native startup, so another package would add no native evidence.
The refreshed worker's `docs/desktop-feedback-refresh.md` owns browser, unit,
Rust and mocked bundled-engine results; those are not new tests by this worker.

## Startup/path audit

The inspected launcher is `desktop/src-tauri/src/lib.rs`; it is byte-identical
between this baseline and the refreshed candidate. The supervisor differs by
feedback route registration, not profile isolation.

| Surface | Actual behavior and consequence |
| --- | --- |
| Native initialization | `run` builds Tauri/plugins, installs the logging plugin in setup, then `plan_boot`, `start_engine`, windows and tray. Isolation must precede all of these, not start after the page loads. |
| Engine/runtime | Bundle resources select the engine; bundled `Contents/MacOS/bun` takes precedence. `BIGBRAIN_ENGINE` overrides the engine and suppresses shim installation, but does not isolate the profile. |
| Native home/shim | Rust `home()` reads `HOME`; `plan_boot` writes/replaces its owned `~/.local/bin/bigbrain` shim before engine startup. A normal packaged launch must exercise this in a synthetic home, not skip it and claim parity. |
| Child environment | `start_supervisor` inherits the launcher's environment and adds vault/desktop/ports; it creates an owned process group and stdin lifetime pipe. Supervisor jobs inherit again but replace `HOME` with Bun `homedir()` and `PATH` with `jobsPath()`. An arbitrary inherited environment is unsafe. |
| Bun home | This exact packaged Bun 1.3.9 **does** honor an explicitly supplied `HOME`; its spawned child does too (test below). This narrows the earlier concern: HOME is insufficient for the whole native app, but it is not ignored by this Bun runtime. |
| Vault/consent/tokens | `lib/engine.ts::configDir()` is `homedir()/.config/bigbrain`. Vault pointer and `telemetry.json` live there. `lib/auth.ts` uses `tokens/<vault-hash>.json` and client-token stores there, with some environment overrides. A scratch vault alone does not isolate them. |
| Provider/plugin state | Claude uses `CLAUDE_CONFIG_DIR` or `~/.claude`; account discovery also reads `~/.claude.json`. Codex uses `CODEX_HOME` or `~/.codex`. Startup refreshes Codex/Claude plugins and retires `~/.bigbrain/plugin` outside dev mode. |
| Executable discovery | `jobsPath()` adds synthetic `~/.local/bin`, bundled Bun's directory, then `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`. PATH-only isolation cannot exclude globally installed provider CLIs; discovery can call auth status and plugin listing. Real CLI/keychain access must be prevented, not just omitted from the test steps. |
| Native preferences/WebView | Production uses the normal persistent WebView; there is no profile override. Tauri logs resolve below home/Library/Logs/app-identifier. A changed bundle identifier separates identity, not all Cocoa/WebKit preferences, caches or services. CFFIXED_USER_HOME redirected Foundation's home in the probe, but NSTemporaryDirectory still resolved to the account's system temp area. |
| Singleton/IPC/processes | No Tauri single-instance plugin is present. Engine identity/occupied-port checks provide attachment and recovery. They can stop matching orphan listeners automatically, or offer to stop another engine. A harness needs exclusive ports and must prohibit signals to existing processes. IPC also includes native invokes, stdin lifetime, and macOS XPC services outside the Bun process tree. |
| Network | Analytics and feedback send server-side to PostHog `/batch/`; feedback is independent of analytics consent. Survey draft status is not an ingestion lock. Updater, provider discovery/integrations and opener are additional network paths. Browser-only request mocks and parent-process socket denial do not contain all native services. |

A release-capable harness would need to prove all these boundaries before
startup. The supplied probe is intentionally **not** such a launcher: it does
not certify arbitrary service IPC, persistent preferences, signal isolation or
external-opening behavior.

## Experiments and evidence

All native experiments used a fabricated window/page and file canaries, an
empty environment plus explicit synthetic paths, and local ephemeral servers.
No production ingestion request, feedback submission, connector credential,
real vault or real profile file was used as test input. No existing app was
terminated. System services' incidental behavior was not exhaustively audited;
that limitation is one reason this is not a containment certificate.

Final probe source SHA-256:
`8a5cb74caae9b1cae75e32a3d0ee45cedee2c0c297a7c635bc7dbd2568bc3b9d`.
macOS **26.6.2**. See `test/support/native-smoke/README.md` for exact commands.

| Experiment | Observed result | Evidence under `/private/tmp` |
| --- | --- | --- |
| Seatbelt deny-network + synthetic HOME/CFFIXED_USER_HOME/TMPDIR + nonpersistent WKWebView | Forbidden file read/write blocked; disposable write allowed. Forbidden loopback fetch **arrived**. Harness exit 1. | `bb-native-boundary-osmcmpql/result.json` |
| Same + WK HTTP CONNECT proxy, failover disabled, proxy forwards only allowed port | Forbidden loopback fetch **arrived directly**, no proxy request recorded. Harness exit 1. This proves loopback bypass, not behavior for every remote destination. | `bb-native-boundary-lyg4ikmk/result.json` |
| Same + pre-navigation WebKit content rules, deny all except test origin | Rule compilation failed with WKErrorDomain code 6. No navigation or HTTP request occurred. Harness exit 1, not a false pass. | `bb-native-boundary-k7wjlptf/result.json` |
| Copied Bun from refreshed package under deny-network/user-directory sandbox, clean HOME; spawn Bun child with supervisor's `HOME: homedir()` behavior | Bun 1.3.9 parent and child both resolved the synthetic home. Exit 0. No engine import or app initialization. | `bb-packaged-home-6i68zqo7/result.json` |
| Harness verdict unit suite | 4 passed: server-side escape beats claimed JS success; compiler failure, missing allowed fetch/checks, crash/timeout statuses cannot pass. | `python3 -m unittest discover -s test/support/native-smoke -p 'test_*.py'` |

The content-rule compilation failure's precise cause is unresolved. The observed
Foundation temp path was outside the allowed disposable root despite TMPDIR;
that is a plausible cause, not a proven diagnosis. WebKit's own
[compiler discussion](https://bugs.webkit.org/show_bug.cgi?id=315236) describes
its use of a platform temporary file. No permission to the account's temp/cache
or profile directories was broadened to make this work.

An initial nested sandbox attempt was refused by the execution sandbox
(`sandbox_apply: Operation not permitted`). Native approvals subsequently
allowed the restrictive synthetic probes. There was **no automatic approval
rejection** and no policy override of a rejection.

## Coverage and remaining decision

Native coverage here is Cocoa/WKWebView **isolation canaries only**. Bundled
runtime coverage is home resolution in the exact refreshed Bun. This worker
adds no browser/UI feature coverage. Production AppShell/Tauri interaction,
CLI shim installation, actual supervisor startup, first-run handover, saved
consent through a native restart, feedback failure/retry in the app, persistent
WebView state, and quit/owned-child cleanup remain untested together.

The current probes do not establish safe containment on this user's desktop.
Do not launch the candidate with only HOME, a new app identifier, seatbelt, a
WebKit proxy or a draft survey as the safety boundary.

Pilot reports no already-provisioned disposable macOS GUI environment known in
context and has asked the owner whether one exists or provisioning is permitted.
That decision is pending. The bounded next choice is an existing/new dedicated
macOS VM or test environment with no real profile/credentials and external
network disabled **before** candidate startup (local loopback retained for the
engine). Provisioning a new VM/account is outside this worker's authorization.
An alternative is a separately scoped deeper WebKit/XPC containment effort;
these experiments do not establish that such a solution is impossible.

When an environment is available, verify candidate hashes again, run the actual
refreshed packaged binary and production shell, then cover first run, consent
choice/persistence/withdrawal, feedback with ingestion blocked, restart and quit.
Any instrumented shell must disclose its source patch/feature flags and cannot
be called an unchanged-release-binary smoke pass.

No push, PR, merge, signing, installation, publishing, PostHog configuration
change, submission/deletion or vendor message was performed. The separate
PostHog support/deletion release gate remains independent of this native blocker.
