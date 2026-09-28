// youtube.js — the YouTube site branch (#79), isolated world. extract.js
// delegates here when BigBrainYouTube.matches(); transcript.js (injected
// before this file) holds the pure parsers; youtube-page.js is the
// MAIN-world half that opens the panel.
//
// Why a site branch exists at all: the generic extractor rests on the
// premise that the author marked their content with semantic landmarks. A
// video app breaks that premise — the content is the transcript, and it is
// not even IN the document until the panel opens. This branch swaps
// extraction strategy, not philosophy: capture the captions verbatim, cue
// timestamps and all, and never imply a transcript the capture does not
// hold.
//
// Why the panel, and not YouTube's transcript API: get_transcript answers
// 400 FAILED_PRECONDITION to everything except the player's own
// instrumented call — probed exhaustively 2026-08-12 (fresh params, full
// harvested INNERTUBE_CONTEXT, matching cookies, ANDROID client; also dead
// from a server, where datacenter IPs hit bot checks before subtitles are
// even requested). A logged-in browser reading the rendered panel is the
// one position YouTube must serve. The dead fetch route lives in git
// history (#232..#244) should YouTube ever relax it.

(function () {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function matches() {
    return (
      (location.hostname === "www.youtube.com" ||
        location.hostname === "youtube.com" ||
        location.hostname === "m.youtube.com") &&
      location.pathname === "/watch" &&
      Boolean(new URLSearchParams(location.search).get("v"))
    );
    // /shorts/, channels, the home feed all fall through to the generic path
    // on purpose: only the watch page has a transcript to capture.
  }

  /** The player response for the video ON SCREEN, whatever the tab's
   * navigation history. The script tags describe the FIRST video this tab
   * loaded; after SPA navigation they are stale — a live capture on
   * 2026-08-12 landed with no description, no duration, and a wrong captions
   * verdict that way. A same-origin fetch of the current URL returns the
   * server-rendered page for THIS video, cookies riding along. Returns null
   * when even the refetch describes some other video. */
  async function freshPlayerResponse(t, urlVideoId) {
    const domText = [...document.querySelectorAll("script")]
      .map((s) => s.textContent ?? "")
      .join("\n");
    const domPr = t.parseVarJson(domText, "ytInitialPlayerResponse");
    if (domPr && t.videoMeta(domPr).videoId === urlVideoId) return domPr;
    const res = await fetch(location.href, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`refetching the watch page answered ${res.status}`);
    const pr = t.parseVarJson(await res.text(), "ytInitialPlayerResponse");
    return pr && t.videoMeta(pr).videoId === urlVideoId ? pr : null;
  }

  /** Open the transcript panel, read the rendered segments. Bounded — the
   * popup declares NO ANSWER at 35s, so every wait here has a deadline.
   *
   * Opening happens via youtube-page.js: YouTube's button ignores synthetic
   * clicks, and only the page's own command dispatcher opens the panel
   * (live diagnosis 2026-08-12). We dispatch a bare Event; the bridge
   * resolves the command; the player loads the segments with its own
   * instrumented call; we read the shared DOM.
   *
   * Both panel generations are read: the classic
   * ytd-transcript-segment-renderer and the 2026 "In this video" card's
   * transcript-segment-view-model rows. */
  async function scrapePanelCues(t) {
    const SEGMENTS = "transcript-segment-view-model, ytd-transcript-segment-renderer";
    document.dispatchEvent(new Event("bigbrain-yt-transcript-open"));
    // Poll until the segment list is non-empty and STABLE across two looks
    // (the panel streams rows in); hard deadline 12s.
    const deadline = Date.now() + 12000;
    let lastCount = 0;
    let nodes = [];
    for (;;) {
      await sleep(250);
      nodes = [...document.querySelectorAll(SEGMENTS)];
      if (nodes.length && nodes.length === lastCount) break;
      lastCount = nodes.length;
      if (Date.now() > deadline) break;
    }
    const rows = nodes.map((node) => {
      const timestamp =
        node.querySelector(".ytwTranscriptSegmentViewModelTimestamp")?.textContent?.trim() ??
        node.querySelector(".segment-timestamp")?.textContent?.trim();
      const text =
        node.querySelector(".ytAttributedStringHost")?.textContent?.trim() ??
        node.querySelector(".segment-text")?.textContent?.trim();
      if (timestamp !== undefined || text !== undefined)
        return { timestamp: timestamp ?? "", text: text ?? "" };
      // class names drifted — fall back to reading the row's text lines
      return t.rowFromLines(node.innerText.split("\n"));
    });
    const cues = t.segmentsToCues(rows);
    if (!cues.length) throw new Error("transcript panel rendered no segments");
    // The opened transcript card stays open: the new surface has no reliable
    // programmatic close, and a visible transcript after "IN THE VAULT" reads
    // as a receipt of what was captured, not as damage.
    return cues;
  }

  /** The whole branch: fresh page data → captions verdict → panel scrape →
   * landed shape. Throws only when the page is unrecognizable; every other
   * failure lands metadata with a reason that names the failing step. */
  async function capture() {
    const api = globalThis.browser ?? globalThis.chrome;
    const t = globalThis.BigBrainTranscript;
    const urlVideoId = new URLSearchParams(location.search).get("v");

    // The isolated world can't see window.ytInitialPlayerResponse — but the
    // literal that created it is in script text (refetched same-origin when
    // the tab's own tags are stale), and parsing that recovers the metadata
    // and every caption track.
    let playerResponse = null;
    try {
      playerResponse = await freshPlayerResponse(t, urlVideoId);
    } catch {
      // refetch failed — carry on with the DOM; the panel scrape can still
      // capture the transcript, and the landing says what it doesn't know
    }
    const meta = playerResponse
      ? t.videoMeta(playerResponse)
      : {
          videoId: urlVideoId,
          title:
            document.querySelector("ytd-watch-metadata h1")?.textContent?.trim() ||
            document.title.replace(/ - YouTube$/, "").trim(),
          channel: document.querySelector("ytd-channel-name a")?.textContent?.trim() ?? "",
          published: "",
          durationSeconds: 0,
          description: "",
        };
    if (!meta.videoId) throw new Error("YouTube page structure not recognized");

    // With no player data the captions verdict is unknowable up front — try
    // the panel anyway and let the outcome speak; "" kind/language are
    // dropped from frontmatter and printed as unknown in the body.
    const info = playerResponse
      ? t.captionInfo(playerResponse)
      : { available: true, kind: "", language: "" };

    let cues = null;
    let finalInfo = info;
    if (info.available) {
      try {
        cues = await scrapePanelCues(t);
      } catch (e) {
        // Name the exact failing step in the landing — the generic "could
        // not be retrieved" cost a diagnosis round-trip on day one.
        finalInfo = {
          available: false,
          reason: `captions exist but the capture could not read them (panel: ${String(e?.message ?? e)})`,
        };
      }
    }

    const frontmatter = t.buildFrontmatter(meta, finalInfo, Boolean(cues));
    const markdown = t.buildBody(meta, finalInfo, cues);
    const name = globalThis.BigBrainSlug.slug(meta.title, {
      maxLen: 60,
      fallback: "youtube-video",
    });
    api.runtime.sendMessage({ type: "bigbrain-capture", name, frontmatter, markdown });
  }

  globalThis.BigBrainYouTube = { matches, capture };
})();
