// background.js — capture the whole page and POST it to the vault's intake
// API (/v1/drop). Toolbar click opens the popup, which fires the capture
// immediately and offers an optional linked note; right-click → "Send page
// to BigBrain" captures without the popup. The heavy lifting (DOM → clean
// markdown + metadata) runs in the page via extract.js; this script injects
// it, then does the POST from here — the background isn't bound by the page's
// CSP, so drops work on strict sites too.
//
// The server stamps provenance (source/submitted_by/received/id) from the
// token; the frontmatter we send is only the non-reserved context the gardener
// wants. We deliberately mint NO `id` of our own: the lake's exact-dupe
// identity is the sha256 of the payload as we send it (lib/intake.ts), so a
// client id carrying a timestamp would make every re-clip of an unchanged
// page land as a fresh reference and a fresh `file` message. The correlation
// id below never leaves the browser.
//
// The capture and the popup's note are NOT two arrivals. The page is
// record — someone else's words, landed in references/. The note is a
// DIRECTIVE — your words, addressed to the gardener, saying what you want it
// to know about the page you just saved. So the note goes to the QUEUE
// (POST /v1/enqueue), naming the page in its `refs`.
//
// That ref is the lake id the DROP RESPONSE reports, which is why the note
// waits for the capture to land: there is nothing to point at before then.
// It is a real pointer, unlike the shared-`url:` join it replaces — it
// works for any arrival, not only the ones that happen to have a URL, and
// it can't collide when the same page is clipped twice.
//
// Cross-browser: `browser` (Firefox/Zen, promise-based) falls back to
// `chrome` (Chrome MV3, also promise-based).

// Chrome's MV3 service worker loads exactly one file (the manifest's
// "service_worker" key), so pull wire.js into this scope ourselves.
// Firefox's non-worker background context already has it: the manifest's
// "background.scripts" array lists wire.js before this file, loading both
// into one shared global — importScripts there would be both redundant
// and undefined outside a worker, hence the guard. Either path leaves
// globalThis.BigBrainWire set before anything below runs.
if (typeof importScripts === "function") importScripts("wire.js");

const api = globalThis.browser ?? globalThis.chrome;

// A browser-local correlation id, so a status message reaches the popup
// that started the capture. It is NOT sent to the vault — see the note on
// dedup above.
const newCorrelationId = () =>
  `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Correlation id per tab, set at injection time and consumed when extract.js
// messages back. Same event turn, so worker teardown between the two is
// not a practical concern.
const pendingIds = new Map();
// The tab's URL as the popup saw it when it fired the capture, keyed the
// same way — what the per-tab record below is matched against (#300).
const pendingUrls = new Map();

// ── what this tab already did (#300) ─────────────────────────────────────
//
// Reopening the popup on a page this tab already clipped must not clip it
// again: a static page dedups on the server, but anything that shifted
// since (a feed, a thread) lands a second reference for real. So a landing
// leaves a per-tab record in storage.session — `tab:<tabId>` → { url,
// pageId, lakeId, refPath } — and the popup, on open, compares the record's
// url with the tab's current one: an exact match means "already in the
// vault", anything else means today's path. Session storage has the right
// lifetime (survives worker teardown, dies with the browser), and the
// record dies sooner: on any navigation or reload of the tab, and when the
// tab closes. The popup keeps its half-typed note beside it as
// `draft:<tabId>` → { url, text }; two keys rather than one so the popup's
// frequent draft writes never race the background's one landing write.
// Exact URL match is the deliberate default: an SPA route change or a hash
// change is a different page as far as this record is concerned, and a
// recapture is the safe answer.
function tabRecordKey(tabId) {
  return `tab:${tabId}`;
}
function draftKey(tabId) {
  return `draft:${tabId}`;
}
function rememberLanding(tabId, url, record) {
  if (tabId == null || !url) return;
  void api.storage.session?.set({ [tabRecordKey(tabId)]: { url, ...record } }).catch(() => {});
}
function forgetTab(tabId) {
  if (tabId == null) return;
  void api.storage.session?.remove([tabRecordKey(tabId), draftKey(tabId)]).catch(() => {});
}
// `status: "loading"` is the one signal every navigation and reload
// sends without the "tabs" permission (changeInfo.url needs it); a route
// change that sends nothing is caught by the popup's exact-URL check.
api.tabs?.onUpdated?.addListener((tabId, info) => {
  if (info?.status === "loading") forgetTab(tabId);
});
api.tabs?.onRemoved?.addListener((tabId) => forgetTab(tabId));

async function inject(details) {
  const results = await api.scripting.executeScript(details);
  // Firefox can resolve the API call with a per-frame error instead of
  // rejecting it. A successful promise alone does not mean the extractor
  // ran; ignoring this shape leaves the popup waiting for a lost message.
  for (const result of results) {
    if (Object.hasOwn(result, "error")) {
      throw new Error(String(result.error?.message ?? result.error ?? "Script injection failed"));
    }
  }
}

// Inject the vendored libs + extractor into the active tab. They share one
// isolated world in a single call, so extract.js sees TurndownService /
// turndownPluginGfm, BigBrainSlug from slug.js, and BigBrainTranscript from
// transcript.js (#79 — the pure YouTube parsers, listed before the
// extractor that calls them). extract.js messages the result back to
// `post` below.
async function capture(tab, pageId, url) {
  if (!tab?.id) return flashBadge("!", "#c0392b");
  pendingIds.set(tab.id, pageId ?? newCorrelationId());
  if (url) pendingUrls.set(tab.id, url);
  try {
    // The MAIN-world bridge goes first, so its event listener exists before
    // extract.js dispatches. It guards itself to YouTube pages; everywhere
    // else it is a no-op. Injected every capture — it de-dupes per page.
    await inject({
      target: { tabId: tab.id },
      world: "MAIN",
      files: ["youtube-page.js"],
    });
    await inject({
      target: { tabId: tab.id },
      files: [
        "vendor/turndown.js",
        "vendor/turndown-plugin-gfm.js",
        "markdown.js",
        "title.js",
        "slug.js",
        "transcript.js",
        "youtube.js",
        "extract.js",
      ],
    });
  } catch {
    // chrome:// / about: / store pages can't be injected. Neither can
    // FIREFOX's built-in PDF viewer — but that refusal, alone, still holds
    // a capturable document: the PDF itself. Try that before giving up.
    // (Chrome's viewer takes the other road to the same place: it accepts
    // injection into the empty wrapper document, so extract.js detects the
    // PDF itself and reports back as bigbrain-pdf-tab below.)
    const id = pendingIds.get(tab.id) ?? pageId ?? newCorrelationId();
    pendingIds.delete(tab.id);
    const r = await capturePdf(tab, id, takeUrl(tab.id));
    if (r === true) return;
    notify("bigbrain-page-status", id, false, r.reason === "not a pdf"
      ? { reason: "the browser could not read this page — reload it and try again" }
      : r);
    await flashBadge("!", "#c0392b");
  }
}

// The PDF viewer is a privileged page in both engines (Chrome's mimehandler
// extension, Firefox's pdf.js), so extract.js can never read the document
// there — Firefox refuses the injection (the catch above), Chrome injects
// into a textless wrapper (the bigbrain-pdf-tab message below). But the
// tab's URL is the PDF's own URL, and invoking the extension granted
// activeTab's temporary host permission for that origin — so the background
// can fetch the bytes itself and ship the document as an attachment, the
// same wire shape the web drop zone uses. No text extraction here (#63):
// pdf.js is ~400kB plus a worker the MV3 background can't spawn; the
// attached original IS the record, and the host extracts the text layer
// on landing (lib/pdfText.ts).
// Returns true on a landing, else `{ reason, origin? }` — the popup
// uppercases the reason into its one failure line ("SEND FAILED" alone
// cost a debugging session on 2026-08-13), and `origin` rides along only
// when a host grant would change the answer, so the popup knows when to
// offer its ALLOW THIS SITE chip.
async function capturePdf(tab, pageId, tabUrl) {
  // The popup path passes only a tabId; the activeTab grant makes the full
  // record (url, title) readable without the "tabs" permission.
  const full = tab.url != null ? tab : await api.tabs.get(tab.id).catch(() => null);
  const url = full?.url ?? "";
  if (!url) return { reason: "the tab's url is not readable" };
  // A local PDF IS a capturable document — the refusal is not "this page
  // has nothing to send" but "this extension cannot read that file", and
  // the reason has to say which, because only one of them has a way out.
  // Neither engine can read it: Firefox grants extensions no file:// host
  // permission at all, and Chrome's "Allow access to file URLs" extends
  // host permissions to file: for CONTENT SCRIPTS, while the fetch below
  // runs in an MV3 service worker, where fetch() takes no file: URL and
  // XMLHttpRequest no longer exists. So there is no grant to request and
  // no origin to hand the popup's ALLOW THIS SITE chip — only the door
  // that does open for a local file, which is the drop zone.
  if (/^file:\/\//i.test(url)) return { reason: "local file — drop it on BigBrain instead" };
  if (!/^https?:\/\//i.test(url)) return { reason: "not a capturable page" };
  const u = new URL(url);
  // Credentials first: the viewer already fetched this URL with the user's
  // cookies, and sending them again is what makes a login-gated PDF land
  // the same bytes the tab is showing. That works where activeTab's grant
  // waives CORS for a background fetch (Chrome). Firefox's grant does not
  // reach the background, and a credentialed request FORBIDS the wildcard
  // Access-Control-Allow-Origin public hosts answer with (arXiv does) — so
  // on failure, retry anonymously and let plain CORS carry the public case.
  const get = (credentials) =>
    fetch(url, { credentials, signal: AbortSignal.timeout(ATTACHMENT_TIMEOUT_MS) });
  const res = await get("include").catch(() => get("omit").catch(() => null));
  // Both refused: Firefox, against a host that offers no CORS of its own
  // (cltc.berkeley.edu, 2026-08-13). Only a real host grant can carry this
  // fetch, and requesting one takes a user gesture the background does not
  // have — so name the origin and let the popup offer the one-click grant
  // (optional_host_permissions). Chrome's activeTab never lands here.
  if (!res) return { reason: "the pdf fetch was blocked", origin: u.origin };
  if (!res.ok) return { reason: `the pdf fetch answered ${res.status}` };
  // The header is the same signal that made the browser open its viewer.
  // Trust it; without it (a .pdf served as octet-stream), require the %PDF
  // magic in the first 1kB (the spec allows leading junk) before shipping.
  const claimed = (res.headers.get("content-type") ?? "").toLowerCase().includes("application/pdf");
  if (!claimed && !/\.pdf$/i.test(u.pathname)) return { reason: "not a pdf" };
  const bytes = new Uint8Array(await res.arrayBuffer().catch(() => new ArrayBuffer(0)));
  if (!bytes.length) return { reason: "the pdf came back empty" };
  if (!claimed && !hasPdfMagic(bytes)) return { reason: "not a pdf" };

  let filename = u.pathname.split("/").filter(Boolean).pop() || "document";
  try {
    filename = decodeURIComponent(filename);
  } catch {
    // a bad escape sequence is fine as-is — the server sanitizes names anyway
  }
  if (!/\.pdf$/i.test(filename)) filename += ".pdf";
  const title = (full?.title || "").trim() || filename;

  // Same identity claim and flavor vocabulary as the web drop zone's PDF
  // path (DropZone.svelte shipPdf): the clip is the extension's act, and
  // `kind: pdf-import` is the established word for a PDF landing. Nothing
  // client-minted rides along — same URL + same bytes dedup to one record.
  const frontmatter = [
    ["from", "send-to-bigbrain"],
    ["from_kind", "agent"],
    ["title", title],
    ["url", url],
    ["site", u.hostname],
    ["filename", filename],
    ["kind", "pdf-import"],
  ].filter(([, v]) => v);
  const markdown =
    "Captured from the browser's PDF viewer. The document rides as the " +
    "attachment below; its text was not extracted at capture time.";
  const name =
    title
      .toLowerCase()
      .replace(/\.pdf$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "pdf";

  land(pageId, { name, frontmatter, markdown, attachments: [{ name: filename, b64: b64(bytes) }] }, {
    id: tab.id,
    url: tabUrl ?? url,
  });
  return true;
}

// The URL the popup fired this tab's capture with, consumed once; the
// sender's own tab url (activeTab makes it readable) is the fallback.
function takeUrl(tabId) {
  const u = pendingUrls.get(tabId);
  pendingUrls.delete(tabId);
  return u;
}

// %PDF anywhere in the first 1kB — the spec tolerates leading junk.
function hasPdfMagic(bytes) {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 3 < head.length; i++)
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46)
      return true;
  return false;
}

// Chunked so multi-MB documents never hit the argument-count ceiling.
function b64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function post({ name, frontmatter, markdown, attachments }) {
  const { endpoint, token } = await api.storage.local.get(["endpoint", "token"]);
  if (!endpoint || !token) {
    await flashBadge("?", "#c0392b");
    api.runtime.openOptionsPage();
    return { ok: false, reason: "not signed in" };
  }
  const fm = BigBrainWire.fmSerialize(frontmatter);
  const body = BigBrainWire.fmBody(fm, markdown);
  // Two wire shapes, matching the server's (lib/api.ts /v1/drop): raw
  // markdown, or JSON { content, attachments } when binaries ride along —
  // which also earns the longer timeout, since attachments can be MBs on a
  // slow uplink (the same bound lib/remote.ts uses).
  const withAtt = !!attachments?.length;
  try {
    const res = await fetch(
      `${endpoint.replace(/\/+$/, "")}/v1/drop?name=${encodeURIComponent(name)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(withAtt ? { "content-type": "application/json" } : {}),
        },
        body: withAtt ? BigBrainWire.dropJsonBody(body, attachments) : body,
        signal: AbortSignal.timeout(withAtt ? ATTACHMENT_TIMEOUT_MS : REQUEST_TIMEOUT_MS),
      }
    );
    await flashBadge(res.ok ? "✓" : "!", res.ok ? "#27ae60" : "#c0392b");
    if (!res.ok) return { ok: false, reason: `the vault answered ${res.status}` };
    // The landed LAKE id — what a following note names in its refs. A host
    // too old to report one leaves this undefined, and the note fails
    // loudly rather than filing prose that points at nothing.
    //
    // `ref_path` is the landed REFERENCE — what the popup's DISCUSS line
    // hands to an agent (#64): readable the moment this response arrives,
    // before the gardener has filed anything, and still readable after
    // (references are add-only; filing cites them, it does not move them).
    // Deliberately NOT `j.path`, which this line used to take: that names
    // the host's gitignored desk copy, under no read tree, so every line
    // built from it was 403 on arrival (#334). A host too old to send
    // `ref_path` leaves this undefined and the popup falls back to its
    // search line — prose that finds the clip beats a path that cannot.
    const j = await res.json().catch(() => ({}));
    return { ok: true, id: j.id, refPath: j.ref_path };
  } catch {
    await flashBadge("!", "#c0392b");
    return { ok: false, reason: "the vault could not be reached" };
  }
}

// Send a DIRECTIVE: refs naming what it concerns, guidance carrying the
// person's words. Our credential is a person-device token, so the server
// stamps `from_kind: person` and the gardener renders the text verbatim as a
// work order rather than framing it as untrusted data. We claim no
// identity — claiming one would be ignored anyway.
async function enqueue(draft) {
  const { endpoint, token } = await api.storage.local.get(["endpoint", "token"]);
  if (!endpoint || !token) {
    await flashBadge("?", "#c0392b");
    api.runtime.openOptionsPage();
    return false;
  }
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/v1/enqueue`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: BigBrainWire.enqueueBody(draft),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    await flashBadge(res.ok ? "✓" : "!", res.ok ? "#27ae60" : "#c0392b");
    return res.ok;
  } catch {
    await flashBadge("!", "#c0392b");
    return false;
  }
}

// pageId → the capture's in-flight landing, so a note typed and sent
// BEFORE the page finishes uploading still gets its ref. Mirrored into
// storage.session because an MV3 service worker may be torn down between
// the capture and the note — the two are separate user actions seconds
// apart, unlike the same-turn injection handshake above.
const landings = new Map();

// One landing path for both captures — the page clip arriving back from
// extract.js and the PDF the background fetched itself — so a note typed in
// the popup can ref either kind the same way.
// `tab` is { id, url } when the capture knows which tab it came from —
// every path but a host too old to say — and is what the per-tab record
// (#300) is written under.
function land(pageId, payload, tab) {
  const landing = post(payload);
  landings.set(pageId, landing);
  landing.then((r) => {
    if (r.id) void api.storage.session?.set({ [`landed:${pageId}`]: r.id });
    if (r.ok && r.id) rememberLanding(tab?.id, tab?.url, { pageId, lakeId: r.id, refPath: r.refPath ?? null });
    const extra = r.ok
      ? r.refPath
        ? { refPath: r.refPath }
        : {}
      : r.reason
        ? { reason: r.reason }
        : {};
    notify("bigbrain-page-status", pageId, r.ok, extra);
  });
}

async function landedId(pageId) {
  const inFlight = landings.get(pageId);
  if (inFlight) return (await inFlight).id;
  const stored = await api.storage.session?.get(`landed:${pageId}`).catch(() => ({}));
  return stored?.[`landed:${pageId}`];
}

// Tell the popup how a send went. It may already be closed — that's fine;
// the catch swallows the "no receiver" rejection. `extra` rides alongside
// the verdict: `{ reason }` on failures — the popup has one line to spend
// on why, and "it broke" spends it badly — and `{ path }` on a landing, so
// the DISCUSS chip can name where the clip now lives.
function notify(type, pageId, ok, extra = {}) {
  api.runtime.sendMessage({ type, pageId, ok, ...extra }).catch(() => {});
}

// No request may hang forever. A socket that never answers is indistinguishable
// from success at this layer, and downstream it becomes a popup that spins
// until it is dismissed — so bound it here, once, for both callers. Requests
// that move a document's actual bytes (the PDF fetch, a drop carrying
// attachments) get the longer bound.
const REQUEST_TIMEOUT_MS = 30_000;
const ATTACHMENT_TIMEOUT_MS = 120_000;

async function flashBadge(text, color) {
  await api.action.setBadgeBackgroundColor({ color });
  await api.action.setBadgeText({ text });
  setTimeout(() => api.action.setBadgeText({ text: "" }), 2000);
}

api.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "bigbrain-capture") {
    const pageId = pendingIds.get(sender.tab?.id) ?? newCorrelationId();
    pendingIds.delete(sender.tab?.id);
    land(pageId, msg, { id: sender.tab?.id, url: takeUrl(sender.tab?.id) ?? sender.tab?.url });
  }
  // extract.js died in the page. The injection itself succeeded, so nothing
  // else in this chain would ever notice.
  if (msg?.type === "bigbrain-capture-failed") {
    const pageId = pendingIds.get(sender.tab?.id);
    pendingIds.delete(sender.tab?.id);
    void flashBadge("!", "#c0392b");
    notify("bigbrain-page-status", pageId, false, msg.reason ? { reason: msg.reason } : {});
  }
  // extract.js ran, but into Chrome's PDF-viewer wrapper document — no
  // title, no text, just the <embed>. The PDF itself is still capturable
  // the same way Firefox's injection *refusal* is handled in capture():
  // fetch the tab's own URL and ship the bytes.
  if (msg?.type === "bigbrain-pdf-tab" && sender.tab) {
    const pageId = pendingIds.get(sender.tab.id) ?? newCorrelationId();
    pendingIds.delete(sender.tab?.id);
    void capturePdf(sender.tab, pageId, takeUrl(sender.tab.id) ?? sender.tab.url).then((r) => {
      if (r === true) return;
      notify("bigbrain-page-status", pageId, false, r);
      void flashBadge("!", "#c0392b");
    });
  }
  if (msg?.type === "bigbrain-popup-capture") capture({ id: msg.tabId }, msg.pageId, msg.url);
  if (msg?.type === "bigbrain-note") {
    const { pageId, note } = msg;
    // Wait for the capture, then point at it. No frontmatter, no title, no
    // filename: a directive is a typed message, not a document — the whole
    // "Note on: <the page's title>" ceremony existed only because this used
    // to have to look like a record item.
    void landedId(pageId).then((id) => {
      if (!id) {
        // The page never landed, or the host reported no id. Losing the
        // note is bad; attaching it to nothing is worse — say so.
        void flashBadge("!", "#c0392b");
        return notify("bigbrain-note-status", pageId, false);
      }
      return enqueue({ refs: [id], guidance: note }).then((ok) =>
        notify("bigbrain-note-status", pageId, ok)
      );
    });
  }
});

/**
 * Retire a credential that points at the hosted service.
 *
 * bigbrain.cool's multi-tenant service was retired on 2026-08-26 (#566); a
 * credential minted there answers nothing now, and an install that still
 * holds one would show CONNECTED on the options page and ship every capture
 * into a red badge that reads like a network blip. Clearing it puts the
 * options page back to NOT CONNECTED, which is both the true statement and
 * the one that offers the fix (pair with the engine on this machine, #486).
 * Anything else — a self-hosted endpoint — is left exactly as it is.
 */
const RETIRED_HOST = "https://bigbrain.cool";

async function dropRetiredCredential() {
  const { endpoint, token } = await api.storage.local.get(["endpoint", "token"]);
  if (!endpoint || !token) return false;
  if (endpoint !== RETIRED_HOST && !endpoint.startsWith(`${RETIRED_HOST}/`)) return false;
  await api.storage.local.remove(["endpoint", "token", "account"]);
  return true;
}

api.runtime.onInstalled.addListener(async (details) => {
  api.contextMenus.create({
    id: "send-to-bigbrain",
    title: "Send page to BigBrain",
    contexts: ["page", "selection"],
  });
  // Fires on update as well as install, which is the point: an upgrade is
  // when a hosted-era credential gets retired.
  const cleared = await dropRetiredCredential();
  // First install — or an upgrade that just cleared a dead credential — opens
  // options, so the first thing a person sees is the pairing form and not a
  // dead toolbar icon. Skipped when a good token already exists.
  if (details.reason === "install" || cleared) {
    const { token } = await api.storage.local.get(["token"]);
    if (!token) api.runtime.openOptionsPage();
  }
});

api.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "send-to-bigbrain") capture(tab, undefined, tab?.url);
});

// No action.onClicked handler: with default_popup set it never fires — the
// popup drives the capture.
