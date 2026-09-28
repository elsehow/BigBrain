// wire.js — the /v1/drop and /v1/enqueue wire shapes, vendored from
// lib/wire.ts (that file is this one's source of truth; see its header for
// the byte-stability invariant this exists to serve). clients/ cannot
// `import` lib/ (same reasoning as vendor/, #246 — slug.js, #306), so this
// is a hand-kept copy of the same functions, not a build artifact.
//
// Loading: Chrome's MV3 service worker loads exactly one file (the
// manifest's "service_worker" key), so background.js pulls this in itself
// with a guarded `importScripts("wire.js")` at its top. Firefox's
// non-worker background context instead gets this file from the
// manifest's "background.scripts" array, which lists wire.js before
// background.js and loads both into one shared global — no importScripts
// there (and none is attempted; the guard in background.js checks for it).
// Either path leaves `globalThis.BigBrainWire` set before background.js's
// own top-level code runs. test/wire.test.ts pins this file's output
// against lib/wire.ts's, the same way test/slug.test.ts does for slug.js.

(function () {
  function FmRaw(text) {
    this.text = text;
  }
  function fmRaw(v) {
    return new FmRaw(v);
  }

  function yq(v) {
    return JSON.stringify(String(v === null || v === undefined ? "" : v));
  }

  function fmSerialize(pairs, opts) {
    const skipEmpty = !!(opts && opts.skipEmpty);
    const rows = skipEmpty
      ? pairs.filter(([, v]) => v !== "" && v !== null && v !== undefined)
      : pairs;
    const lines = rows.map(([k, v]) => `${k}: ${v instanceof FmRaw ? v.text : yq(v)}`);
    return ["---", ...lines, "---", ""].join("\n");
  }

  function fmBody(fm, body) {
    return `${fm}\n${body}\n`;
  }

  function dropJsonBody(content, attachments) {
    return JSON.stringify({ content, attachments });
  }

  function enqueueBody(draft) {
    return JSON.stringify(draft);
  }

  globalThis.BigBrainWire = { FmRaw, fmRaw, fmSerialize, fmBody, dropJsonBody, enqueueBody };
})();
