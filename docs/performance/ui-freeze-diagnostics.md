# Local desktop freeze capture

## Finding, 2026-09-21

The installed 0.7.23 shell freezes its native main thread while synchronously
waiting for `aerospace list-windows`. Focusing the installed app reproduced it:
`/tmp/bigbrain-focus-native.txt` records 3,881 of 8,812 main-thread samples in
`aerospace_window -> Command::output -> read_output -> poll`.
The initial diagnostic build separately measured 14,807 ms of main-thread queue
delay at startup while JavaScript timers continued and frame callbacks stalled.
This establishes a native blocking path; GPU IPC errors alone did not establish it.

Both window-state and window-toggle commands now execute on Tauri's blocking
worker pool through async commands. TopBar coalesces pending focus/resize state
requests. In an initial live run of the corrected native build, 49 logged input
events reached their second frame callback within 65 ms; 12 native probes had
at most 2 ms queue delay. An AeroSpace query still took 13,946 ms on its worker,
but it no longer blocked the native event loop. External-command latency is not
fixed by this change. This short run is not proof against every possible freeze.
The user then confirmed that the corrected diagnostic app responds normally to
the UI actions that froze the installed release.

The installed app is unchanged; the corrected native binary is running in the
separate `/tmp/BigBrain Diagnostics.app`. Unit tests cover timing signals and
content exclusion. WebKit integration checks exercise graph-on/off navigation
and verify that a burst of 30 resize events starts only one pending state query.

## Running the diagnostic build

This diagnostic build is based on v0.7.23. It is disabled unless launched with
`BIGBRAIN_UI_DIAGNOSTICS=on` or `graph-off`. It does not add PostHog events.
The diagnostic proxy blocks writes and absorbs telemetry, so browsing in the
diagnostic window does not create usage events or modify notes/Pilot sessions.
Write controls will fail in this window; use navigation to reproduce the freeze.

Build the viewer (`cd web/ui && bun run build`) and native shell. The native
build also needs the normal Bun sidecar/resource stub (`sh desktop/build-resources.sh
--bun-only`). Use a separate app identifier for the native build:

```sh
cd desktop/src-tauri
TAURI_CONFIG='{"identifier":"cool.bigbrain.diagnostics","productName":"BigBrain Diagnostics"}' cargo build --release --offline
```

Keep the installed BigBrain running. Start `bun bin/ui-diagnostics.ts` from the
repository root. Launch the diagnostic native shell with these environment values:

```text
BIGBRAIN_UI_DIAGNOSTICS=on
BIGBRAIN_ENGINE=/Applications/BigBrain.app/Contents/Resources/resources/engine
BIGBRAIN_BUN=/Applications/BigBrain.app/Contents/MacOS/bun
BIGBRAIN_WEB_URL=http://127.0.0.1:53919/
```

The shell attaches to the installed app's existing engine. It does not own or stop
that supervisor. Its window has independent navigation state. Quit only the
diagnostic app to change modes, then relaunch with `graph-off` for comparison.
That mode omits the graph component entirely (rather than merely hiding its canvas).

Logs: `~/Library/Logs/cool.bigbrain.diagnostics/BigBrain Diagnostics.log`.
Native log records have wall-clock times; JS samples also include milliseconds
since initialization. Only fixed event names and numbers are recorded. No key
values, element text, note IDs, URLs, error messages, or prompt contents are logged.

## Reading a capture

- `native_probe_sent` without `native_main`: native main-thread delay.
- `native_main` without matching JS `native_probe`: JS/evaluation/IPC stall;
  this alone does not distinguish those three causes.
- `input_*`: JS received an input, with `[elapsed_ms, dispatch_delay_ms]`.
- `input_frame` / `input_settled`: first and second frame callback delays for
  that input ID. These are callback timing, **not proof of screen presentation**.
- `heartbeat` values: elapsed time, timer interval, input count, frame probe
  count, completed graph draws, max draw time, age of last frame probe, age of last
  graph draw, document hidden, document focused. Ages are -1 before the first event.
- `error`: JS line/column only. `rejection`: unhandled rejection.
- `render_error`: a graph draw threw. Existing exception behavior is preserved.
- `context_lost` / `context_restored`: WebGL context events.

Try the same short sequence with graph on and off: memory navigation, Enter,
Escape, Recents, scrolling, settings. Note the wall-clock time of a visible freeze.
If JS and frame callbacks continue while the image is frozen, capture native/GPU
stacks at that time. If graph-off changes the result, isolate its rendering layers
next. A clean diagnostic window does not rule out a problem with the original
window's state, native window settings, or OS WebKit.

The one-second frame probe and native logging add some overhead and can alter
timing. Background windows are tagged; do not treat their frame throttling as a
foreground freeze. Input logs are rate-limited and native calls have a bounded
in-flight count. This is an explicit short investigation, not always-on tracing.

For future opt-in PostHog telemetry, aggregate slow interaction counts, delay
distributions, and render/context failure counts by release and foreground state.
Do not upload per-key or per-frame traces. A permanent hang cannot report its own
completion; missing heartbeats need a separate native observer and careful handling
of sleep, occlusion and backgrounding before they become a reliable metric.
