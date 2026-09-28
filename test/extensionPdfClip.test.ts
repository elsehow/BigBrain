/**
 * The PDF branch of the extension background — clients/browser-extension/
 * background.js capturePdf. Each engine reaches it its own way: Firefox's
 * viewer REFUSES injection (the capture() catch), Chrome's viewer ACCEPTS
 * injection into a textless wrapper document, which extract.js detects and
 * reports as bigbrain-pdf-tab (2026-08-13 — the wrapper capture landed an
 * empty "untitled-page" before that guard existed). Either way the
 * background fetches the document's own URL — cookies first, anonymous
 * retry when credentialed CORS refuses (Firefox against arXiv's wildcard
 * ACAO) — and ships the bytes as an attachment through /v1/drop's JSON
 * wire shape. That whole chain runs against a stubbed browser here,
 * because the one-frame version of this bug ("clipping a PDF does
 * nothing") is exactly what a manual check misses across two browsers.
 *
 * background.js binds its listeners at import time, so the stub browser
 * must exist BEFORE the import, and the import happens once: every test
 * shares module state and steers behavior through `scenario`. That is
 * also why the per-tab record tests (#300, at the end) live here rather
 * than in their own file — bun runs every file in one process, and a
 * second importer would get this module bound to the first stub.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";

type Msg = Record<string, unknown>;

let onMessage: (msg: Msg, sender: Msg) => void;
let onUpdated: (tabId: number, info: Msg) => void;
let onRemoved: (tabId: number) => void;
const sent: Msg[] = [];
// storage.session as a Map: the per-tab record (#300) is the one piece of
// browser state the background writes that a later popup reads.
const session = new Map<string, unknown>();
const fetches: { url: string; init: RequestInit }[] = [];

// Per-test knobs: what the tab looks like, and what its URL serves.
// `injectable` is the engine switch — false is Firefox's viewer (injection
// refused), true is Chrome's (injection lands in the empty wrapper, and the
// PDF arrives via the bigbrain-pdf-tab message instead).
// `corsBlocksCredentialed` is Firefox against a wildcard-ACAO host: the
// cookie-carrying fetch is refused, the anonymous retry is not.
const scenario = {
  tab: { id: 1, url: "https://arxiv.org/pdf/2603.07280", title: "2603.07280" } as {
    id: number;
    url?: string;
    title?: string;
  },
  body: new TextEncoder().encode("%PDF-1.4 minimal"),
  contentType: "application/pdf",
  status: 200,
  injectable: false,
  injectionErrorAt: 0,
  injectionCalls: 0,
  corsBlocksCredentialed: false,
  // Firefox against a host with no CORS at all: every background fetch of
  // the document dies, whatever its credentials mode.
  fetchBlocked: false,
};

const drops = () => fetches.filter((f) => f.url.includes("/v1/drop"));

// The chain behind the listener is fire-and-forget promises; poll until the
// expected effect lands rather than guessing at tick counts.
async function until(cond: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error("condition never held");
}

// bun test runs every file in ONE process: a global left stubbed here is a
// global some later file's server tests fetch through. Restore both.
const realFetch = globalThis.fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  delete (globalThis as Record<string, unknown>)["chrome"];
});

beforeAll(async () => {
  (globalThis as Record<string, unknown>)["chrome"] = {
    runtime: {
      onMessage: { addListener: (fn: typeof onMessage) => (onMessage = fn) },
      onInstalled: { addListener: () => {} },
      sendMessage: (m: Msg) => (sent.push(m), Promise.resolve()),
      openOptionsPage: () => {},
    },
    contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
    action: {
      setBadgeBackgroundColor: () => Promise.resolve(),
      setBadgeText: () => Promise.resolve(),
    },
    storage: {
      local: { get: () => Promise.resolve({ endpoint: "https://bigbrain.cool", token: "t" }) },
      session: {
        get: (keys: string | string[]) => {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) if (session.has(k)) out[k] = session.get(k);
          return Promise.resolve(out);
        },
        set: (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) session.set(k, v);
          return Promise.resolve();
        },
        remove: (keys: string | string[]) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) session.delete(k);
          return Promise.resolve();
        },
      },
    },
    scripting: {
      executeScript: () =>
        ++scenario.injectionCalls === scenario.injectionErrorAt
          ? Promise.resolve([{ frameId: 0, error: "Unable to load script" }])
          : scenario.injectable
          ? Promise.resolve([])
          : Promise.reject(new Error("Cannot access contents of the page")),
    },
    tabs: {
      get: () => Promise.resolve({ ...scenario.tab }),
      onUpdated: { addListener: (fn: typeof onUpdated) => (onUpdated = fn) },
      onRemoved: { addListener: (fn: typeof onRemoved) => (onRemoved = fn) },
    },
  };
  // background.js's own importScripts guard is a no-op outside a worker
  // (as in this test), so wire.js must be loaded first ourselves — same
  // load order Firefox's manifest "background.scripts" array gives it.
  await import("../clients/browser-extension/wire.js");
  globalThis.fetch = ((url: string | URL, init: RequestInit = {}) => {
    fetches.push({ url: String(url), init });
    if (String(url).includes("/v1/drop"))
      return Promise.resolve(
        // A live host's receipt names BOTH landings — the desk copy and the
        // committed reference (#334). The fixture carries both so this test
        // can prove the extension picks the readable one.
        new Response(
          JSON.stringify({
            path: "inbox/x.md",
            id: "ref-1",
            ref_path: "references/2026-08-13-x.md",
          }),
          { status: 200 }
        )
      );
    if (scenario.fetchBlocked || (scenario.corsBlocksCredentialed && init.credentials === "include"))
      return Promise.reject(new TypeError("NetworkError when attempting to fetch resource."));
    return Promise.resolve(
      new Response(scenario.body, {
        status: scenario.status,
        headers: { "content-type": scenario.contentType },
      })
    );
  }) as typeof fetch;
  await import("../clients/browser-extension/background.js");
});

test("a PDF-viewer tab lands the document as an attachment, not a failure", async () => {
  onMessage({ type: "bigbrain-popup-capture", tabId: 1, pageId: "p1" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p1"));

  const status = sent.find((m) => m["pageId"] === "p1");
  expect(status?.["type"]).toBe("bigbrain-page-status");
  expect(status?.["ok"]).toBe(true);
  // The landed REFERENCE rides along: it is what the popup's DISCUSS line
  // hands to an agent (#64), readable there before triage files anything —
  // and it is the reference, not the desk copy `path` also names, which no
  // read tree serves (#334).
  expect(status?.["refPath"]).toBe("references/2026-08-13-x.md");
  expect(status?.["path"]).toBeUndefined();

  // The document fetch carries the user's cookies — a login-gated PDF must
  // land the same bytes the viewer is showing.
  const doc = fetches.find((f) => f.url === "https://arxiv.org/pdf/2603.07280");
  expect(doc?.init.credentials).toBe("include");

  const drop = drops()[0];
  expect(drop.url).toContain("name=2603-07280");
  expect((drop.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  const body = JSON.parse(String(drop.init.body));
  // arXiv's path has no extension; the attachment name must still say .pdf.
  expect(body.attachments).toEqual([{ name: "2603.07280.pdf", b64: expect.any(String) }]);
  expect(atob(body.attachments[0].b64)).toStartWith("%PDF-1.4");
  for (const line of [
    'from: "send-to-bigbrain"',
    'from_kind: "agent"',
    'kind: "pdf-import"',
    'url: "https://arxiv.org/pdf/2603.07280"',
    'filename: "2603.07280.pdf"',
  ])
    expect(body.content).toContain(line);
});

test("a note typed after the clip refs the landed id — PDFs are not second-class", async () => {
  onMessage({ type: "bigbrain-note", pageId: "p1", note: "read this" }, {});
  await until(() => sent.some((m) => m["type"] === "bigbrain-note-status"));
  const enq = fetches.find((f) => f.url.includes("/v1/enqueue"));
  // Byte-exact, not just structurally equal (#294's enqueueBody): a plain
  // JSON.stringify of the draft, key order as constructed.
  expect(String(enq?.init.body)).toBe(JSON.stringify({ refs: ["ref-1"], guidance: "read this" }));
});

// #294: post()'s frontmatter+body composition, exercised outside the PDF
// branch — extract.js's own capture message shape, straight to post(),
// with no injection/fetch-sniff machinery in the way. Byte-exact, since
// this is exactly what lib/wire.ts's fmSerialize/fmBody must reproduce.
test("a plain page capture's fm + body is byte-exact (background.js post())", async () => {
  onMessage(
    {
      type: "bigbrain-capture",
      name: "example-page",
      frontmatter: [
        ["from", "send-to-bigbrain"],
        ["from_kind", "agent"],
        ["title", "Example Page"],
        ["url", "https://example.com/a"],
        ["site", "example.com"],
        ["kind", "web-clip"],
      ],
      markdown: "Hello world",
    },
    { tab: { id: 5 } }
  );
  await until(() => fetches.some((f) => f.url.includes("name=example-page")));
  const drop = fetches.find((f) => f.url.includes("name=example-page"));
  expect(String(drop?.init.body)).toBe(
    '---\nfrom: "send-to-bigbrain"\nfrom_kind: "agent"\ntitle: "Example Page"\nurl: "https://example.com/a"\nsite: "example.com"\nkind: "web-clip"\n---\n\nHello world\n'
  );
});

test("an uninjectable non-PDF page still reports failure, and drops nothing", async () => {
  scenario.tab = { id: 2, url: "https://addons.mozilla.org/blocked", title: "AMO" };
  scenario.contentType = "text/html";
  scenario.body = new TextEncoder().encode("<html>not a pdf</html>");
  const before = drops().length;
  onMessage({ type: "bigbrain-popup-capture", tabId: 2, pageId: "p2" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p2"));
  expect(sent.find((m) => m["pageId"] === "p2")?.["ok"]).toBe(false);
  // The popup's one failure line gets a WHY, not just a verdict.
  expect(sent.find((m) => m["pageId"] === "p2")?.["reason"]).toContain("the browser could not read this page");
  expect(drops().length).toBe(before);
});

for (const failureAt of [1, 2]) {
  test(`Firefox's resolved injection error at stage ${failureAt} reports failure without dropping a page`, async () => {
    scenario.tab = { id: 20, url: "https://example.org/article", title: "Article" };
    scenario.contentType = "text/html";
    scenario.body = new TextEncoder().encode("<html>an ordinary page</html>");
    scenario.injectable = true;
    scenario.injectionCalls = 0;
    scenario.injectionErrorAt = failureAt;
    const pageId = `injection-error-${failureAt}`;
    const before = drops().length;
    try {
      onMessage({ type: "bigbrain-popup-capture", tabId: 20, pageId }, {});
      await until(() => sent.some(m => m["pageId"] === pageId));
      const status = sent.find(m => m["pageId"] === pageId);
      expect(status?.["ok"]).toBe(false);
      expect(status?.["reason"]).toContain("the browser could not read this page");
      expect(scenario.injectionCalls).toBe(failureAt);
      expect(drops().length).toBe(before);
    } finally {
      scenario.injectable = false;
      scenario.injectionErrorAt = 0;
    }
  });
}

test("a .pdf path served as octet-stream is admitted by its magic, junk is not", async () => {
  scenario.tab = { id: 3, url: "https://example.org/files/paper%20final.pdf", title: "" };
  scenario.contentType = "application/octet-stream";
  scenario.body = new TextEncoder().encode("\n\n%PDF-1.7 real enough");
  onMessage({ type: "bigbrain-popup-capture", tabId: 3, pageId: "p3" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p3"));
  expect(sent.find((m) => m["pageId"] === "p3")?.["ok"]).toBe(true);
  const body = JSON.parse(String(drops().at(-1)?.init.body));
  // %-escapes decode into the attachment name; the title falls back to it.
  expect(body.attachments[0].name).toBe("paper final.pdf");
  expect(body.content).toContain('title: "paper final.pdf"');

  scenario.tab = { id: 4, url: "https://example.org/files/junk.pdf", title: "" };
  scenario.body = new TextEncoder().encode("GIF89a definitely not a pdf");
  const before = drops().length;
  onMessage({ type: "bigbrain-popup-capture", tabId: 4, pageId: "p4" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p4"));
  expect(sent.find((m) => m["pageId"] === "p4")?.["ok"]).toBe(false);
  expect(drops().length).toBe(before);
});

// Chrome's viewer does NOT refuse injection — extract.js lands in the empty
// wrapper document and reports bigbrain-pdf-tab instead of capturing
// nothing (2026-08-13: an arXiv clip landed as a bodyless "untitled-page").
// The popup's pageId must survive the handoff: popup-capture parks it in
// pendingIds, the pdf-tab message claims it.
test("Chrome's PDF wrapper reports bigbrain-pdf-tab, and the document lands", async () => {
  scenario.injectable = true;
  scenario.corsBlocksCredentialed = false;
  scenario.tab = { id: 6, url: "https://arxiv.org/pdf/2604.07733", title: "CivBench" };
  scenario.contentType = "application/pdf";
  scenario.status = 200;
  scenario.body = new TextEncoder().encode("%PDF-1.7 civbench");
  onMessage({ type: "bigbrain-popup-capture", tabId: 6, pageId: "p6" }, {});
  onMessage({ type: "bigbrain-pdf-tab" }, { tab: { ...scenario.tab } });
  await until(() => sent.some((m) => m["pageId"] === "p6"));
  expect(sent.find((m) => m["pageId"] === "p6")?.["ok"]).toBe(true);
  const body = JSON.parse(String(drops().at(-1)?.init.body));
  expect(body.attachments).toEqual([{ name: "2604.07733.pdf", b64: expect.any(String) }]);
  scenario.injectable = false;
});

// Firefox: activeTab's grant does not waive CORS for a background fetch,
// and a cookie-carrying request forbids the wildcard ACAO arXiv answers
// with — the credentialed fetch dies, the anonymous retry carries it.
test("a CORS-refused credentialed fetch retries anonymously and still lands", async () => {
  scenario.injectable = false;
  scenario.corsBlocksCredentialed = true;
  scenario.tab = { id: 7, url: "https://arxiv.org/pdf/2604.07733", title: "CivBench" };
  onMessage({ type: "bigbrain-popup-capture", tabId: 7, pageId: "p7" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p7"));
  expect(sent.find((m) => m["pageId"] === "p7")?.["ok"]).toBe(true);
  const docFetches = fetches.filter((f) => f.url === "https://arxiv.org/pdf/2604.07733");
  expect(docFetches.at(-2)?.init.credentials).toBe("include");
  expect(docFetches.at(-1)?.init.credentials).toBe("omit");
  scenario.corsBlocksCredentialed = false;
});

// A host with no CORS at all (cltc.berkeley.edu, 2026-08-13): both fetch
// attempts die in Firefox, and only a host grant can fix it. The failure
// must carry the origin so the popup can offer ALLOW THIS SITE — and only
// this failure, so the chip never shows where a grant would change nothing.
test("a fully blocked fetch names its origin for the popup's grant chip", async () => {
  scenario.fetchBlocked = true;
  scenario.tab = { id: 9, url: "https://cltc.berkeley.edu/uploads/profile.pdf", title: "GPAI" };
  onMessage({ type: "bigbrain-popup-capture", tabId: 9, pageId: "p9" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p9"));
  const status = sent.find((m) => m["pageId"] === "p9");
  expect(status?.["ok"]).toBe(false);
  expect(status?.["reason"]).toBe("the pdf fetch was blocked");
  expect(status?.["origin"]).toBe("https://cltc.berkeley.edu");
  scenario.fetchBlocked = false;
});

// A PDF opened from disk (file:///…/paper.pdf in Firefox's viewer,
// 2026-08-31). It reaches capturePdf exactly like a remote one — the
// viewer is privileged, injection is refused — but no extension can read
// a file: URL from an MV3 service worker, on either engine. The old
// `^https?://` gate called it "not a capturable page", which is both
// wrong and a dead end; the reason now names the door that opens.
test("a local pdf is refused by name, and points at the drop zone", async () => {
  scenario.tab = { id: 11, url: "file:///Users/demo/Downloads/AGI%20and%20the%20Income%20Distribution.pdf", title: "AGI" };
  onMessage({ type: "bigbrain-popup-capture", tabId: 11, pageId: "p11" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p11"));
  const status = sent.find((m) => m["pageId"] === "p11");
  expect(status?.["ok"]).toBe(false);
  expect(status?.["reason"]).toBe("local file — drop it on BigBrain instead");
  // No origin: a host grant cannot reach file:, so the popup must not
  // offer its ALLOW THIS SITE chip here.
  expect(status?.["origin"]).toBeUndefined();
  // And nothing was fetched — the gate stands before the request.
  expect(fetches.some((f) => f.url.startsWith("file://"))).toBe(false);
});

test("a fetch that answers an error names the status in the failure reason", async () => {
  scenario.tab = { id: 8, url: "https://example.org/gone.pdf", title: "" };
  scenario.contentType = "application/pdf";
  scenario.status = 404;
  onMessage({ type: "bigbrain-popup-capture", tabId: 8, pageId: "p8" }, {});
  await until(() => sent.some((m) => m["pageId"] === "p8"));
  const status = sent.find((m) => m["pageId"] === "p8");
  expect(status?.["ok"]).toBe(false);
  expect(status?.["reason"]).toBe("the pdf fetch answered 404");
  scenario.status = 200;
});

// ── what a tab already did (#300) ────────────────────────────────────────
//
// A landing leaves `tab:<tabId>` → { url, pageId, lakeId, refPath } in
// storage.session, keyed to the url the popup fired the capture with;
// popup.js reads it on open and skips the capture while the url still
// matches exactly. The record and the draft beside it die on navigation,
// reload, and tab close.

const URL7 = "https://x.test/y?z=1";
const clip7 = { type: "bigbrain-capture", name: "y", frontmatter: [["title", "Y"], ["url", URL7]], markdown: "hi" };

// The popup fires with the tab's url; extract.js answers from the tab.
function landOn(tabId: number, pageId: string, url?: string) {
  scenario.injectable = true;
  onMessage({ type: "bigbrain-popup-capture", tabId, pageId, url }, {});
  onMessage(clip7, { tab: { id: tabId, url } });
}

test("a landing leaves the per-tab record the popup reads on reopen", async () => {
  session.clear(); // earlier tests landed on their own tabs; this section starts clean
  landOn(70, "p70", URL7);
  await until(() => session.has("tab:70"));
  expect(session.get("tab:70")).toEqual({
    url: URL7,
    pageId: "p70",
    lakeId: "ref-1",
    refPath: "references/2026-08-13-x.md",
  });
  // The landing's own mirror is still there — the note path reads it.
  expect(session.get("landed:p70")).toBe("ref-1");
});

test("a note sent from the restored popup names that landing", async () => {
  const before = fetches.filter((f) => f.url.includes("/v1/enqueue")).length;
  onMessage({ type: "bigbrain-note", pageId: "p70", note: "worth a second look" }, {});
  await until(() => fetches.filter((f) => f.url.includes("/v1/enqueue")).length > before);
  const body = JSON.parse(String(fetches.filter((f) => f.url.includes("/v1/enqueue")).pop()!.init.body));
  expect(body.refs).toEqual(["ref-1"]);
  expect(body.guidance).toBe("worth a second look");
});

test("navigation and reload forget the record and the draft; so does closing the tab", async () => {
  session.set("draft:70", { url: URL7, text: "half a thou" });
  onUpdated(70, { status: "loading" });
  await until(() => !session.has("tab:70") && !session.has("draft:70"));
  // A status that is not a load — a title change, say — leaves it alone.
  landOn(70, "p70b", URL7);
  await until(() => session.has("tab:70"));
  onUpdated(70, { title: "Y (2)" });
  await new Promise((r) => setTimeout(r, 20));
  expect(session.has("tab:70")).toBe(true);
  onRemoved(70);
  await until(() => !session.has("tab:70"));
});

test("a capture that cannot say which url it was is not recorded — the popup will recapture", async () => {
  landOn(80, "p80", undefined);
  await until(() => sent.some((m) => m["pageId"] === "p80" && m["type"] === "bigbrain-page-status"));
  expect(session.has("tab:80")).toBe(false);
});
