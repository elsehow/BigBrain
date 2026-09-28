# Graph selection

`lib/graphView.ts` owns portable selection and exclusions. The app binds
`app.graphView` to both the graph and the relationship briefing:

```json
{"selected":["alpha","beta"],"excluded":["shared"]}
```

IDs and note/source/member aliases resolve before rendering and briefing
requests. IDs are deduplicated and sorted; exclusions win conflicts. Unknown
IDs remain in the portable view until data resolves them, without inventing
nodes or relationships.

- Click selects one node and opens its note or conversation.
- Shift-click adds an anchor, preserving the current document and highlighting
  the union of selected neighborhoods. The text tab describes the combined view.
- Ctrl-click excludes a node on mouse press, including macOS browsers that omit
  `pointerdown`. Excluded nodes cannot be picked or revived by agent activity.
- Home j/k previews neighborhoods without committing selection. The camera
  glides to each preview, preserving zoom and avoiding the menu/text panels.
- Hover lights the node and its first-degree connections. It preserves the
  hovered node's position while unrelated nodes recede. Explored neighborhoods
  remain layered; after leaving, a delay precedes their smooth cosine return.
- Note-link probes and app highlights light direct connections without moving
  the camera, committing selection, or starting hover excavation.
- Drag blank ground to pan, drag a node to move it, and wheel/pinch to zoom
  smoothly around the depth plane under the pointer.
- Escape or double-clicking blank ground clears selection/exclusions and
  restores the home framing. New selection ends manual camera ownership.

Empty selection shows the overview. Focus preserves the home layout/depth
silhouette and dims unrelated context. Memory neighborhoods retain quiet
second-hop context; dense selections cap edge opacity. Selection never creates
new edges. Active agents retain their real attachment links until archived.

`LinkGraph` accepts bindable `viewState` and exposes `getViewState()`,
`getPresentation()`, `getCamera()`, and `resetOverview()`. App view state remains
separate from camera, layout, hover history, and lighting. See
[renderer architecture](graph-renderer.md) and [note briefings](note-briefings.md).

Regression checks:

```sh
bun test test/graphView.test.ts test/graphRendererView.test.ts test/graphHoverHistory.test.ts
node test/support/graphSelection.browser.cjs
node test/support/graphHomeNavigation.browser.cjs
node test/support/graphHighlight.browser.cjs
```

These browser checks use the real production AppShell with fabricated APIs,
including real pointer modifiers, text-tab keyboard probes, narrow/large
viewports, Escape, reduced motion, and native-resolution canvases.
