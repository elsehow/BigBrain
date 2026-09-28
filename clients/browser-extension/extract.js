// extract.js — runs IN THE PAGE (injected after the vendored turndown files,
// which define the globals `TurndownService` and `turndownPluginGfm`, and
// after markdown.js + slug.js + transcript.js + youtube.js, which define
// `BigBrainMarkdown`, `BigBrainSlug`, `BigBrainTranscript` and `BigBrainYouTube`). It captures the page
// faithfully and hands the result to the background, which does the POST —
// the background isn't subject to the page's CSP, so the drop works even on
// strict-CSP sites.
//
// Philosophy: this is an integration, so it CAPTURES, it doesn't INTERPRET.
// We honor the author's own semantic landmarks (<main>/<article>) and strip
// non-content by semantics (nav/footer/aside/script/hidden) — never by
// guessing which block is "the real article." That judgment belongs to the
// gardener downstream, which can handle boilerplate but can't recover
// content thrown away here.
//
// Site branches live in their own files and are delegated to at the top:
// youtube.js (#79) is the first — a video app keeps its content out of the
// document until a panel opens, so no semantic walk can capture it. A future
// branch (arXiv, #63) follows the same shape: a matches() guard and a
// capture() that sends the same message this file does.
//
// Async on purpose (site branches fetch and poll); the try/catch wraps every
// await, so a thrown branch failure still reports through the same
// bigbrain-capture-failed path — never a silent death, never a floating
// rejection.

(async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  try {
    // Chrome's PDF viewer ACCEPTS injection — into the wrapper document
    // around the <embed>, which has no title, no meta and no text, so the
    // semantic walk below would faithfully capture an empty "Untitled page"
    // (it did — 2026-08-13). The wrapper still says what it is, so hand the
    // tab back to the background's PDF path instead of extracting nothing.
    // Firefox never reaches this line on a PDF: its viewer refuses injection
    // outright, and that refusal routes to the same capturePdf.
    if (document.contentType === "application/pdf") {
      api.runtime.sendMessage({ type: "bigbrain-pdf-tab" });
      return;
    }

    if (globalThis.BigBrainYouTube?.matches()) {
      await globalThis.BigBrainYouTube.capture();
      return;
    }

    const meta = (sel) => document.querySelector(sel)?.getAttribute("content")?.trim() || "";
    const firstMeta = (...sels) => {
      for (const s of sels) {
        const v = meta(s);
        if (v) return v;
      }
      return "";
    };

    const url = document.querySelector('link[rel="canonical"]')?.href || location.href;
    const title = globalThis.BigBrainTitle.resolve({
      title: firstMeta('meta[property="og:title"]', 'meta[name="twitter:title"]') || document.title,
      heading: document.querySelector("h1")?.textContent,
      url,
    });
    const site = firstMeta('meta[property="og:site_name"]') || location.hostname;
    const author = firstMeta('meta[name="author"]', 'meta[property="article:author"]');
    const published =
      firstMeta('meta[property="article:published_time"]', 'meta[name="date"]') ||
      document.querySelector("time[datetime]")?.getAttribute("datetime") ||
      "";
    const description = firstMeta('meta[property="og:description"]', 'meta[name="description"]');

    // Root: the author's declared main content if they marked it, else the body.
    const landmark =
      document.querySelector("main") || document.querySelector("article") || document.body;
    const root = landmark.cloneNode(true);

    // Strip non-content by SEMANTICS (declared tags/roles), not by density.
    const STRIP = [
      "script",
      "style",
      "noscript",
      "template",
      "svg",
      "canvas",
      "iframe",
      "object",
      "embed",
      "nav",
      "footer",
      "aside",
      "form",
      "button",
      "input",
      "select",
      "textarea",
      "link",
      "meta",
      "[hidden]",
      '[aria-hidden="true"]',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="contentinfo"]',
      '[role="complementary"]',
      '[role="search"]',
    ];
    root.querySelectorAll(STRIP.join(",")).forEach((el) => el.remove());

    // Absolutize links/images so they still resolve once out of the page.
    root.querySelectorAll("a[href]").forEach((a) => a.setAttribute("href", a.href));
    root.querySelectorAll("img[src]").forEach((img) => img.setAttribute("src", img.src));

    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      hr: "---",
    });
    td.use(turndownPluginGfm.gfm); // tables, strikethrough, task lists
    globalThis.BigBrainMarkdown?.configure(td); // house rules (markdown.js): links around blocks
    let markdown = td.turndown(root.innerHTML).trim();

    // SPA / thin-extraction fallback: if almost nothing survived (client-rendered
    // page with no semantic markup), ship the rendered text rather than an empty
    // note — faithful capture means never returning nothing.
    if (markdown.replace(/\s+/g, "").length < 200) {
      const text = (document.body?.innerText || "").trim();
      if (text.length > markdown.length) markdown = text;
    }

    // Identity: this capture is the EXTENSION's act, not the user's words —
    // the page is someone else's. Our credential is a person-device token, so
    // without this claim intake would stamp the article `from_kind: person`
    // and every consumer that weights user voice (the memory pass, the
    // viewer's provenance band) would read Rich Sutton's essay as Nick's own.
    // `agent` is the one identity a payload may self-assert (lib/intake.ts
    // stampIntake); it wins over the credential's person stamp, and the token
    // still records who submitted it. The popup's note claims nothing — those
    // ARE the user's words, and inherit `person` from the credential.
    //
    // Typing stays a single declared flavor word: `web-clip` is a
    // FLAVOR_TO_TYPE row (lib/envelope.ts), so the lake landing derives
    // type: reference + category: web-clip + tags: [web-clip]. Declaring
    // `type: reference` alongside it would win the type slot and cost the tag.
    const frontmatter = [
      ["from", "send-to-bigbrain"],
      ["from_kind", "agent"],
      ["title", title],
      ["url", url],
      ["site", site],
      ["author", author],
      ["published", published],
      ["description", description],
      ["kind", "web-clip"],
    ].filter(([, v]) => v);

    const name = globalThis.BigBrainSlug.slug(title, { maxLen: 60, fallback: "page" });

    api.runtime.sendMessage({ type: "bigbrain-capture", name, frontmatter, markdown });
  } catch (e) {
    // A throw in here used to be SILENT, and silence is the one failure the
    // rest of the chain cannot see. `scripting.executeScript` resolves fine
    // when the script it injected throws — the injection worked — so the
    // background sits waiting for a message that will never arrive and the
    // popup spins on SENDING forever. Every OTHER failure path (an
    // uninjectable page, a bad response, a dead network) reports itself.
    // This one now does too: a capture that died is information, an
    // animation that never ends is not.
    api.runtime.sendMessage({
      type: "bigbrain-capture-failed",
      reason: String(e?.message ?? e).slice(0, 160),
    });
  }
})();
