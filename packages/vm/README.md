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
gh run download <run-id> -n machine-arm64 -D packages/agents/image/out
gunzip -k packages/agents/image/out/rootfs.img.gz
bun run vm:build
BIGBRAIN_VM_TESTS=vz bun test packages/agents/test/machine.test.ts
bun packages/agents/test/machine.spike.ts            # about 10 minutes; --quick for 5
```

The spike writes `spike-results.md`, the table the plan's go/no-go reads.
