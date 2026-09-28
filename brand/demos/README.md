# Reshooting the BigBrain demos

The reusable choreography is in `recorder/record.cjs`: keys, clicks, text,
pauses, screenshots, 1920×1080 viewport, and H.264 export settings. Each run
also saves measured beat timestamps in `takes/<scene>-<timestamp>/timings.json`,
alongside the original WebM and checkpoint screenshots. `takes/` is ignored
by Git. The scripts and fixtures are source files; keep them when deleting videos.

## Setup and run

Requires Bun, Node/npm, Google Chrome, and ffmpeg + ffprobe on PATH.
Run `bun install` at the repository root on a fresh checkout first.
The default browser is installed Google Chrome, not Playwright’s downloaded Chromium.

```sh
# Terminal 1, from repository root:
cd web/ui
bun install
bunx vite --host 127.0.0.1 --port 5181 --strictPort

# Terminal 2, from repository root:
cd brand/demos/recorder
npm install
npm run meeting
npm run inbox
npm run context
npm run assembly
```

Outputs (unique timestamp per reshoot, to avoid stale video previews):

- `BigBrain-meeting-agent-<timestamp>-1080p.mp4`
- `BigBrain-inbox-36-unreads-blue-<timestamp>-1080p.mp4`

Optional environment variables: `DEMO_URL` (default `http://127.0.0.1:5181`),
`DEMO_OUTPUT` (output directory), `DEMO_BROWSER` (Playwright browser channel,
default `chrome`), `PLAYWRIGHT_MODULE` (an existing Playwright installation).

## Meeting

Default theme. Start on the populated graph → Cmd-K → search “Weekly sync”
→ open meeting → Shift-Enter → “What are the action items?” → context adds
Alex, Launch plan, and Customer interviews → “Do them.” → a working agent
appears → collapse to the compact bottom text tab and hold on the animation.

Fixture: `web/ui/src/dev/meetingDemo.ts`, route `/meeting-action-demo.html`.
Voiceover: “When I finish a meeting, I ask an agent to tell me the action items
and—do them.”

## Inbox

OG web blue. Start on 36 unread messages across three inboxes and three Slack
channels → Shift-Enter → Pilot attaches to all 36 → hold → “What needs my
attention?” → reduce context to three actionable messages → expand left to
read the answer.

Fixture: `web/ui/src/dev/inboxDemo.ts`, route `/inbox-demo.html`.
Voiceover: “Instead of checking a million inboxes and Slacks, I ask an agent:
what needs my attention?”

## Capture conventions

- 1080p, 30fps MP4, silent; add voiceover in the editor.
- No baked-in demo labels. Nick adds disclosures in the video editor.
- All content and responses are fictional deterministic fixtures, not live
  accounts or model runs. Meeting worker activity is simulated too.
- Production components, with dev-only recording typography/layout overrides.
  The underlying production UI now also supports left expansion.
- User messages retain the app’s inline “You” label, regular weight, and muted
  text; enlarged to 20px rather than headline typography.
- Meeting and inbox recordings check animation frames for duplicate user messages and
  fail on browser errors. Export happens only after those checks pass.
- Holds live beside their corresponding actions; recorded timings include
  browser/model-fixture/render waits, so exact total duration can vary.

## Atlas context · seven-second take

Run `npm run context` in `recorder/`. Choreography is in `context.cjs` and
fixtures are in `web/ui/src/dev/contextDemo.ts` (`/context-demo.html`).

Phosphor theme. Start on “What’s next on the Atlas project?” at the native UI framing.
No editorial zooms, pans, or crops; Nick handles those in the video editor.
The fixed left panel does not move within the UI. From 1.5–3.1 seconds,
context expands in batches of 3, 5, 8, 11, and 13 Atlas nodes, using the real
Pilot graph renderer and worker activity animation. At 3.6 seconds the
sample answer becomes available; production polling can add up to a second.
Hold on three concrete next steps and their sources through the end.

The recorder saves lossless PNG browser frames and their durations in
`frames.txt`, a reference WebM, actual cue timestamps, and `layout-check.json`.
It verifies constant drawer geometry/theme, checks the answer appears, and
fails on browser errors. Export uses PNG frames to avoid double compression,
and produces exactly 210 frames at 30fps, 1920×1080.
Recording-only layout styles live in `web/ui/src/dev/contextDemo.css`.
No voiceover or baked-in labels. Answers and activity are fictional fixtures.
Output: `BigBrain-atlas-context-phosphor-unzoomed-<timestamp>-7s-1080p.mp4`.

## Messages assembling · light theme

Run `npm run assembly` in `recorder/`. Preview route:
`/inbox-demo.html?theme=default&assembly=1`.
Start on 36 unread messages, open Pilot with Shift-Enter at 1.8 seconds,
and hold as all 36 attach. The text tab stays compact. This is an 8-second,
1080p/30fps UI-only take: no question/answer, zoom, or overlays. Uses lossless
browser frames; saves choreography, timing metadata, and an ending screenshot.

## Reproducing or editing a take

Start the Vite server above; no BigBrain backend, personal vault, API keys, or
model subscriptions are needed. Fixtures intercept API requests in the browser
and suppress presence beacons. Use a fresh browser tab/reload to reset a scene.
The HTML entries and fixture code are dev-only and are not production build entries.

Each recorder prints the exported MP4 path. All exports, raw captures, and
screenshots in this directory are ignored by Git; only source is committed.
`DEMO_OUTPUT` can redirect everything to an external folder (that folder’s own
ignore rules then apply). Do not delete the fixtures when clearing old takes.

- **Meeting/inbox:** edit `recorder/record.cjs` for keys, typing speed, pauses,
  and checkpoint timing. Edit `meetingDemo.ts` / `inboxDemo.ts` for sample
  content, responses, graph layout, and node counts. Their complete takes have
  variable duration; do not trim their waits to match a seven-second voiceover.
- **Atlas:** edit the `cues` array in `recorder/context.cjs` for connection counts
  and response timing. These are milliseconds after capture begins, not page
  navigation. The 7.3-second source sequence is fit into a seven-second export.
  `contextDemo.ts` supplies the Atlas nodes, response, and `bb:context-cue`
  event handler. `contextDemo.css` locks the recording panel in place.
- **Assembly:** edit `recorder/assembly.cjs` for the 1.8-second opening and
  6.2-second hold. It shares the inbox fixture, requests default/light via URL,
  and skips the fixture’s automatic sidebar expansion.
- **Style:** `typeStudy.css` retains the recording typography; themes are set
  by the fixtures (meeting default, inbox web blue, Atlas phosphor).

For manual Atlas takes, open `/context-demo.html` and dispatch this from the
browser console, changing `count` to 3, 5, 8, 11, then 13; finally set `answer`
to true. Other scenes use the normal app controls described above.

```js
window.dispatchEvent(new CustomEvent('bb:context-cue', {
  detail: { count: 13, answer: true }
}));
```

## Other preserved preview studies

These preserve design exploration, not additional automatic recording targets:

| Route | Purpose / source |
| --- | --- |
| `/meeting-demo.html` | Earlier meeting/action-items specimen (`meetingDemo.ts`) |
| `/typography.html` | Typography controls around real App iframe (`TypographyWorkbench.svelte`) |
| `/type-app.html` | Fictional Atlas transcript used by typography workbench (`typeApp.ts`) |
| `/left-sidebar.html` | Experimental search + reading sidebar (`leftSidebar.ts/.css`) |
| `/text-sidebar.html` | Experimental always-left reading panels (`textSidebar.css`) |
| `/video-demo.html` | Early standalone conceptual mockup (`VideoDemoWorkbench.svelte`); not the real app |

The last three are historical alternatives, not the final shipped interaction.
Some studies have their own explanatory UI; use the four recorder commands
above for clean footage without baked-in labels, zooms, or pans.

## Checks and troubleshooting

`cd web/ui && bun run check` checks fixture types. For a full smoke test, run
all four recorder commands: they fail on page errors, and meeting/inbox also
check duplicate user turns. Atlas checks fixed panel geometry and theme color.
Inspect the final answer/connection frame, not just whether an MP4 was written.

Use `ffprobe -v error -show_entries stream=width,height,r_frame_rate,nb_frames,duration
-of json <file.mp4>` (one line) to check the export. Atlas should be 210 frames;
assembly 240; all are 1920×1080 at 30 fps. Graph motion, installed fonts, browser
versions, and real UI changes can affect pixels; these scripts reproduce the
sequence, not byte-identical historical footage. Check out this commit in a
separate worktree if you need its exact UI baseline.

If a selector times out, open that scene URL and inspect the current UI before
changing the recorder. If Chrome is absent, install it or install Playwright’s
Chromium and set `DEMO_BROWSER=chromium`. PNG-based Atlas/assembly capture avoids
the color drift seen with double-compressed screen recordings. Their PNG frames
can use substantial disk space, and `takes/` can be deleted after review.
