# bigbrain-vm

The helper that boots one desktop's machine on macOS
(`docs/plans/2026-10-12-contained-desktops.md`, D1 and D2). Swift,
Virtualization.framework, macOS 12 or later. One process per running
machine. It interprets nothing the guest says.

```
echo '<config>' | bigbrain-vm               # boot; JSON state lines on stdout
echo '<config>' | bigbrain-vm --dump-config # the devices it would configure
```

The config is one line of JSON: `kernel`, `initramfs`, `cmdline`, `cpus`,
`memoryMiB`, `disk`, `console` (a log file), `guestSocket` (it listens; each
connection reaches the guest's vsock port 7470), `egressSocket` (the engine
listens; the guest's connections to vsock port 7471 arrive there), and
`balloon` (optional, default true). After the config, stdin takes `stop`;
stdin closing, SIGTERM, SIGINT and SIGHUP stop the machine too, so it never
outlives the engine. The machine has a disk, vsock, a console, entropy and a
balloon: no network device and no shared folder.

`packages/agents/src/machine.ts` is its caller.

## Build

```
bun run vm:build    # swift build -c release, then codesign -s - with vm.entitlements
```

The one entitlement, `com.apple.security.virtualization`, needs no Apple
approval: an ad-hoc signature carries it. The app's bundler signs its own
copy with the app's entitlements (Phase 3a).

## On the maintainer's Mac: the spike

GitHub's macOS runners can't nest virtualization, so booting a machine with
this helper happens on a Mac. CI (`.github/workflows/machine.yml`) builds the
image on each architecture and compiles the helper.

```
bun run vm:spike          # or: bun run vm:spike --quick
```

That downloads the latest CI image for the Mac's architecture into
`packages/agents/image/out`, builds and signs the helper, runs the VM suite
(`BIGBRAIN_VM_TESTS=vz`), then the spike. The spike writes
`spike-results.md`, the table the plan's go/no-go reads. The clock row is
by hand: `bun packages/agents/test/machine.spike.ts --clock`, then sleep the
Mac for ten minutes and wake it.

## On the maintainer's Mac: everything else only a Mac can test

```
bun run vm:verify
```

Builds both helpers, takes the CI image for the branch, and runs the
sandbox and Harbor's macOS tests (through a Seatbelt-confined guest), the
host's desktop tests, and the VM and contained-desktop suites on
Virtualization.framework. It ends with one line per suite.
