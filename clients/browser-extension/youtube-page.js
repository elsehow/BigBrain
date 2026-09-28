// youtube-page.js — the MAIN-world half of the YouTube branch (#79). Injected
// by background.js with `world: "MAIN"` just before the isolated batch, on
// every capture (it guards itself to YouTube watch pages and to one install
// per page).
//
// Why it exists: YouTube's transcript button ignores synthetic clicks — the
// panel opens only through the page's own command dispatcher
// (`ytd-app.resolveCommand`), and Polymer component data like
// `section.data.primaryButton…command` is a page-JS object the isolated
// world cannot see (verified live, 2026-08-12: pointer-event sequences,
// ancestor clicks, and attribute forcing all left the panel closed; the
// command dispatch opened it and the player then loaded the segments with
// its own instrumented call — the only call get_transcript accepts).
//
// Contract with extract.js: a plain DOM Event, no payload in either
// direction. The isolated side dispatches "bigbrain-yt-transcript-open";
// this side resolves the section's open command; the isolated side reads the
// rendered rows from the shared DOM. No extension APIs exist in this world
// and none are used; nothing from the page is read beyond the one command
// object handed straight back to YouTube's own resolver.

(function () {
  if (window.__bigbrainYtTranscriptBridge) return;
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return;
  window.__bigbrainYtTranscriptBridge = true;

  document.addEventListener("bigbrain-yt-transcript-open", () => {
    try {
      const section = document.querySelector("ytd-video-description-transcript-section-renderer");
      const d = section && section.data;
      const button = d && d.primaryButton;
      const cmd =
        (button && button.buttonRenderer && button.buttonRenderer.command) ||
        (button &&
          button.buttonViewModel &&
          button.buttonViewModel.onTap &&
          button.buttonViewModel.onTap.innertubeCommand);
      const app = document.querySelector("ytd-app");
      if (cmd && app && typeof app.resolveCommand === "function") {
        app.resolveCommand(cmd);
      } else if (section) {
        // No dispatcher (layout drift) — a real click is the only other hope.
        const b = section.querySelector("button");
        if (b) b.click();
      }
      // Silence on failure is fine: the isolated side times out waiting for
      // rows and lands an honest "panel: …" reason.
    } catch {
      /* same: the isolated side reports the absence, not this throw */
    }
  });
})();
