// slug.js — text→identifier normalizer, vendored from lib/slug.ts.
// clients/ cannot import lib/ (same reasoning as vendor/, #246), so this
// is a hand-kept copy of the same function. Injected before youtube.js and
// extract.js, which both call it; everything hangs off globalThis.BigBrainSlug.

(function () {
  function slug(s, opts) {
    const { maxLen, fallback = "" } = opts || {};
    let out = (s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (maxLen) out = out.slice(0, maxLen);
    return out || fallback;
  }

  globalThis.BigBrainSlug = { slug };
})();
