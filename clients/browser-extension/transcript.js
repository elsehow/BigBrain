// transcript.js — the pure half of the YouTube branch (#79): parsers and
// formatters only. No DOM, no fetch, no chrome.* — youtube.js does the
// fetching and panel reading, this file turns what it got into cues,
// frontmatter and a markdown body. The split is what makes the branch
// testable at all: bun imports this file directly
// (test/extensionTranscript.test.ts), the same way extensionCube.test.ts
// imports cube.js, so YouTube's inevitable format churn shows up as ONE
// failing pure function with a pinned fixture, not as a silent capture
// regression.
//
// Loaded by background.js's injection list ahead of youtube.js, same
// isolated world; everything hangs off globalThis.BigBrainTranscript.

(function () {
  /** Pull a `var <name> = {…};` JSON literal out of raw <script> text. The
   * isolated world cannot see page globals (window.ytInitialPlayerResponse),
   * but the literal that CREATED them is sitting in script text — so this
   * brace-matches from the first `{` after the name (JSON.parse on a guessed
   * slice is wrong the moment the object contains `};` in a string). */
  function parseVarJson(scriptText, varName) {
    let from = 0;
    for (;;) {
      const at = scriptText.indexOf(varName, from);
      if (at < 0) return null;
      from = at + varName.length;
      const eq = scriptText.indexOf("=", at + varName.length);
      if (eq < 0) return null;
      const open = scriptText.indexOf("{", eq);
      if (open < 0 || scriptText.slice(eq + 1, open).trim() !== "") continue;
      let depth = 0;
      let inStr = false;
      for (let i = open; i < scriptText.length; i++) {
        const c = scriptText[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === '"') inStr = false;
        } else if (c === '"') inStr = true;
        else if (c === "{") depth++;
        else if (c === "}" && --depth === 0) {
          try {
            return JSON.parse(scriptText.slice(open, i + 1));
          } catch {
            break; // not a JSON literal after all — try the next occurrence
          }
        }
      }
    }
  }

  /** Last-resort panel row reader, for when the segment's class names have
   * drifted: split the row's rendered lines into { timestamp, text }. The
   * 2026 rows read "0:07" / "7 seconds" / "On that workday…" — the duration
   * line is an a11y duplicate of the timestamp and must not enter the cue. */
  function rowFromLines(lines) {
    const clean = lines.map((l) => String(l ?? "").trim()).filter(Boolean);
    const timestamp = clean.find((l) => /^\d{1,2}:\d{2}(:\d{2})?$/.test(l)) ?? "";
    // a WHOLE line of durations ("7 seconds", "1 hour, 2 minutes") is the
    // a11y label; a sentence that merely starts with one is content
    const durationLine =
      /^\d+\s+(seconds?|minutes?|hours?)(,\s*\d+\s+(seconds?|minutes?|hours?))*$/;
    const text = clean.filter((l) => l !== timestamp && !durationLine.test(l)).join(" ");
    return { timestamp, text };
  }

  /** Panel-scrape rows ({ timestamp: "1:02:03" | "12:04", text }) →
   * [{ startMs, text }] — the one cue shape everything downstream reads. */
  function segmentsToCues(rows) {
    const cues = [];
    for (const row of rows) {
      const parts = String(row.timestamp ?? "")
        .trim()
        .split(":")
        .map((p) => Number(p));
      if (!parts.length || parts.some((n) => !Number.isFinite(n))) continue;
      const seconds = parts.reduce((acc, n) => acc * 60 + n, 0);
      const text = String(row.text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      if (text) cues.push({ startMs: seconds * 1000, text });
    }
    return cues;
  }

  /** What the player response says about captions — the decision input for
   * the whole branch. `available: false` carries a human-readable `reason`
   * that lands IN the capture (a capture must say plainly when it holds no
   * transcript, never imply one it lacks). Manual tracks win over ASR: same
   * video, fewer recognition errors. */
  function captionInfo(playerResponse) {
    const status = playerResponse?.playabilityStatus;
    if (status && status.status && status.status !== "OK") {
      const why = status.reason ? ` (${String(status.reason).replace(/\s+/g, " ").trim()})` : "";
      return {
        available: false,
        reason: `video is not playable without sign-in or membership${why}, so captions could not be read`,
      };
    }
    const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) {
      return playerResponse?.videoDetails?.isLive
        ? { available: false, reason: "live stream — captions were not available at capture time" }
        : { available: false, reason: "this video has no caption tracks" };
    }
    const manual = tracks.find((t) => t.kind !== "asr");
    const track = manual ?? tracks[0];
    return {
      available: true,
      kind: track.kind === "asr" ? "asr" : "manual",
      language: track.languageCode ?? "",
    };
  }

  function videoMeta(playerResponse) {
    const d = playerResponse?.videoDetails ?? {};
    const micro = playerResponse?.microformat?.playerMicroformatRenderer ?? {};
    return {
      videoId: d.videoId ?? "",
      title: d.title ?? "",
      channel: d.author ?? "",
      published: micro.publishDate ?? "",
      durationSeconds: Number(d.lengthSeconds) || 0,
      description: d.shortDescription ?? "",
    };
  }

  /** The canonical watch URL — strips `&t=`, `&list=`, tracking params, all
   * of it, so two clips of one video carry one url. */
  function canonicalUrl(videoId) {
    return `https://www.youtube.com/watch?v=${videoId}`;
  }

  function formatTimestamp(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  const singleLine = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim();

  /** The frontmatter pairs, background.js-shaped: single-line scalar values
   * only (its yq JSON-quotes strings — a list would land as a broken quoted
   * string and cleanTags would drop it). One declared flavor word and NO
   * `type:` — `kind: transcript` is a FLAVOR_TO_TYPE row, so the landing
   * derives type: reference + category: transcript + tags: [transcript];
   * declaring type alongside would win the slot and cost the tag. A capture
   * that holds no transcript declares `web-clip` instead — a transcript tag
   * on a note without one is exactly the lie #79 forbids.
   *
   * stream/key are the #46 arrival identity: youtube/<video id>. No `seq` —
   * two captures of one video are duplicates whichever caption track they
   * carry. (If re-capture ever needs supersedes semantics, `seq: <capture
   * ISO timestamp>` is the value to add.) */
  function buildFrontmatter(meta, info, hasTranscript) {
    return [
      ["from", "send-to-bigbrain"],
      ["from_kind", "agent"],
      ["title", meta.title],
      ["url", meta.videoId ? canonicalUrl(meta.videoId) : ""],
      ["site", "YouTube"],
      ["author", meta.channel],
      ["published", meta.published],
      ["duration", meta.durationSeconds ? formatTimestamp(meta.durationSeconds * 1000) : ""],
      ["description", singleLine(meta.description).slice(0, 300)],
      ["caption_kind", hasTranscript ? info.kind : ""],
      ["language", hasTranscript ? info.language : ""],
      ["kind", hasTranscript ? "transcript" : "web-clip"],
      ["stream", "youtube"],
      ["key", meta.videoId],
    ].filter(([, v]) => v);
  }

  /** The body, granola-shaped (integrations/granola/run.ts): the informative
   * metadata first — intake's excerpt window reads from the top — then the
   * verbatim material under a banner. Cue timestamps are KEPT, one cue per
   * line: they are the video's structure and nothing downstream can recover
   * them once flattened. `cues === null` ⇒ the plain unavailable statement
   * (`reason`) instead of a banner. */
  function buildBody(meta, info, cues) {
    const lines = [`# ${meta.title || "YouTube video"}`, ""];
    if (meta.channel) lines.push(`Channel: ${meta.channel}`);
    if (meta.published) lines.push(`Published: ${meta.published}`);
    if (meta.durationSeconds)
      lines.push(`Duration: ${formatTimestamp(meta.durationSeconds * 1000)}`);
    if (meta.videoId) lines.push(`URL: ${canonicalUrl(meta.videoId)}`);
    // kind/language may be unknown when the panel was read without player
    // data (the refetch failed) — say so rather than print blanks
    const kindLabel = info.kind || "unknown kind";
    const langLabel = info.language || "unknown language";
    if (cues) lines.push(`Captions: ${kindLabel} (${langLabel})`);
    lines.push("");
    if (meta.description) {
      lines.push("> Video description (author's own, verbatim):");
      for (const dLine of String(meta.description).split("\n")) lines.push(`> ${dLine}`);
      lines.push("");
    }
    if (cues) {
      lines.push(
        `--- VERBATIM TRANSCRIPT (YouTube captions: ${kindLabel}, ${langLabel}; [MM:SS] = cue start) ---`
      );
      lines.push("");
      for (const cue of cues) lines.push(`[${formatTimestamp(cue.startMs)}] ${cue.text}`);
    } else {
      lines.push(`No transcript: ${info.reason}.`);
    }
    return `${lines.join("\n")}\n`;
  }

  globalThis.BigBrainTranscript = {
    parseVarJson,
    rowFromLines,
    segmentsToCues,
    captionInfo,
    videoMeta,
    canonicalUrl,
    formatTimestamp,
    buildFrontmatter,
    buildBody,
  };
})();
