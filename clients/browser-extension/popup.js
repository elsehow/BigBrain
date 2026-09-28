// popup.js — opens on toolbar click. The page send fires IMMEDIATELY (no
// confirm step); the popup exists to catch an optional note about it.
//
// They are two different things, not two arrivals: the page is RECORD (its
// author's words, landed in references/), the note is a DIRECTIVE (yours,
// addressed to the gardener, naming the page in its refs). The background
// holds the note until the capture lands, since the ref is the id that
// landing returns. Closing the popup without sending a note costs nothing —
// which is the whole reason ingestion never waits on your typing.
//
// Two surfaces carry state, and they carry DIFFERENT state:
//
//   the mark      is work in flight — it turns while anything is uploading,
//                 whether that is the page or a note, and comes to rest on
//                 its own angle when nothing is (see cube.js).
//   the eyebrow   is the PAGE: SENDING → IN THE VAULT, or SEND FAILED.
//   the hint row  is the NOTE, and otherwise the keys you can press.
//
// Layout is the design mockup ("Browser extension.dc.html"); design.css holds
// it, including the padding arithmetic that puts note text and chip text on
// one left edge.

const api = globalThis.browser ?? globalThis.chrome;

const $ = (id) => document.getElementById(id);

// Browser-local only: routes status messages back to THIS popup. Nothing
// derived from it is sent to the vault (a volatile id in the payload would
// defeat the lake's re-clip dedup). Reassigned when the popup reopens on a
// page this tab already clipped (#300): it adopts the landing's id, so a
// note sent now still finds that landing in the background.
let pageId = `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const KEYS = "ESC CLOSE · ↵ SEND NOTE";

// What the popup is waiting on. `landed` gates the DISCUSS chip and the
// Shift+Enter binding — there is nothing to discuss until something is filed.
let landed = false;
let mark = null;
let tabId = null;
// The tab's URL as read at open, exactly — the per-tab record and the note
// draft (#300) are both keyed to it, and "same page" means this string.
let tabUrl = "";

// Firefox's PDF path: a background fetch the browser will only allow with a
// host grant, and a grant request the browser will only take from a user
// gesture — which the background does not have and this popup does. The
// failure message names the origin; the ALLOW THIS SITE chip asks and
// retries. Chrome never sends the origin (activeTab covers its fetch).
let blockedOrigin = null;

// A backstop, not a policy. Every failure the chain KNOWS about reports
// itself, so reaching this deadline means a message went missing — a service
// worker torn down mid-flight, a page that took the capture with it. It says
// we stopped hearing, which is true, rather than claiming a verdict it does
// not have; what it must not do is leave the mark turning on nothing.
const ANSWER_DEADLINE_MS = 35_000;
let answered = false;
let deadline = 0;

// ── the two status surfaces ──────────────────────────────────────────────

function setPageStatus(text, tone) {
  const el = $("status");
  el.textContent = text;
  el.className = tone ? `eyebrow is-${tone}` : "eyebrow";
}

// The hint row doubles as the note's status line: same slot, same right edge,
// so a message never shifts the card. Splitting on "·" is the mockup's
// KeyHint, which sets each shortcut as its own non-wrapping span.
function setHints(text, tone) {
  const el = $("hints");
  el.className = tone ? `hints is-${tone}` : "hints";
  el.replaceChildren(
    ...text
      .split("·")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const span = document.createElement("span");
        span.textContent = s;
        return span;
      })
  );
}

// The mark turns for as long as SOMETHING is uploading, so a note sent while
// the page is still in flight does not stop it early.
let inFlight = 0;
function beginWork() {
  inFlight += 1;
  mark?.spin();
}
function endWork(done) {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight > 0) return done?.();
  mark?.settle(done);
}

// ── the page being filed ─────────────────────────────────────────────────

// A label, not a link: the host and path are what identify a page at a
// glance, and the capture carries the real canonical URL anyway.
function prettyUrl(raw) {
  try {
    const u = new URL(raw);
    return (u.host.replace(/^www\./, "") + u.pathname).replace(/\/$/, "") + u.search;
  } catch {
    return raw ?? "";
  }
}

// ── the DISCUSS chip ─────────────────────────────────────────────────────

// Hands you the prompt to open elsewhere with what you just filed as its
// context. It copies rather than navigates: which assistant you paste into
// is your business, and the extension has no opinion about it.
//
// The landed REFERENCE's vault-relative path, from the page-status
// message. It exists the moment the drop confirms — before the gardener has
// filed or linked anything — which is what lets the very next paste be a
// discussion of the thing just captured (#64), and it keeps working after
// filing, since references are add-only.
//
// The reference, not the desk copy the drop response also names: that one
// was gitignored, served by no read tree, and deleted by the pass, so a line
// built from it 403s immediately (#334). Null when the host sends no
// reference path — see the fallback in discuss() below.
let landedPath = null;

function discuss() {
  // One discuss idiom, shared verbatim with the viewer's DISCUSS chips
  // (web/ui/src/lib/discuss.ts, which explains the choice; the extension
  // has no build step, so the literal is repeated here and
  // test/discussLine.test.ts holds the two together). The title line is
  // the fallback for a host too old to report a reference path — search
  // can still find the clip, where the old title-only prose gave the agent
  // nothing fetchable at all. It is also why the desk-copy path is not
  // used as a second-best (#334): a search line that finds the clip beats
  // a path the vault refuses.
  const title = $("pageTitle").textContent;
  const prompt = landedPath
    ? `/bigbrain:discuss ${landedPath}`
    : `Search my BigBrain vault for "${title}" and discuss what I clipped with me.`;
  navigator.clipboard?.writeText(prompt).catch(() => {});
  const label = $("discuss").lastElementChild;
  label.textContent = "COPIED";
  setTimeout(() => {
    label.textContent = "DISCUSS";
  }, 1600);
}

// ── wiring ───────────────────────────────────────────────────────────────

api.runtime.onMessage.addListener((msg) => {
  if (msg?.pageId !== pageId) return;

  if (msg.type === "bigbrain-page-status") {
    answered = true;
    clearTimeout(deadline);
    landed = Boolean(msg.ok);
    if (msg.ok && msg.refPath) landedPath = msg.refPath;
    setPageStatus(msg.ok ? "IN THE VAULT" : "SEND FAILED", msg.ok ? "done" : "failed");
    // A failure gets the hint row, which is otherwise only showing you keys
    // you already know. Why it broke is worth more than that.
    if (!msg.ok && msg.reason) setHints(String(msg.reason).toUpperCase(), "failed");
    // A failure that a host grant would fix gets the chip that asks for one.
    blockedOrigin = !msg.ok && msg.origin ? msg.origin : null;
    $("allow").hidden = !blockedOrigin;
    // The chip appears only once the mark stops, so the two land together
    // rather than the chip popping in over a still-turning cube.
    endWork(() => {
      if (landed) $("discuss").hidden = false;
    });
  }

  if (msg.type === "bigbrain-note-status") {
    // QUEUED, not FILED: /v1/enqueue returns once the directive is written to
    // queue/, which is a promise that it will not be lost — not that the
    // gardener has acted on it. It says what it can actually vouch for. The
    // page's own line CAN say IN THE VAULT, because /v1/drop only answers
    // after the landing commit.
    setHints(msg.ok ? "NOTE QUEUED" : "NOTE FAILED", msg.ok ? "done" : "failed");
    if (msg.ok) clearDraft();
    // Close on the mark's landing, not on a timer racing it — the point of
    // the animation is that you see the thing come to rest.
    endWork(() => {
      if (msg.ok) setTimeout(() => window.close(), 320);
    });
  }
});

async function init() {
  // Signed out? Prompt instead of firing a capture that can only fail (the
  // old path: "Sending page…" → "?" badge → options page in a background
  // tab — three surfaces to say one thing).
  const { endpoint, token } = await api.storage.local.get(["endpoint", "token"]);
  if (!endpoint || !token) {
    $("signin").hidden = false;
    BigBrainCube.mount($("signin").querySelector(".cube-stage"));
    $("openOptions").addEventListener("click", () => {
      api.runtime.openOptionsPage();
      window.close();
    });
    return;
  }

  $("capture").hidden = false;
  mark = BigBrainCube.mount($("capture").querySelector(".cube-stage"));
  setHints(KEYS);

  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  const url = prettyUrl(tab?.url);
  $("pageTitle").textContent = tab?.title || url || "this page";
  $("pageUrl").textContent = url;
  tabId = tab?.id;
  tabUrl = tab?.url ?? "";

  // What this tab already did (#300). A landing record whose url is
  // exactly the tab's current url means the page is already in the vault:
  // show that, and make the popup what you reopened it for — the note.
  // Anything else is today's path. The draft comes back either way when
  // it was typed on this same url; it resets with the page, on purpose.
  const { record, draft } = await recall();
  if (record) restore(record);
  else fireCapture();
  if (draft) $("note").value = draft;
  $("note").focus();
}

async function recall() {
  if (tabId == null || !tabUrl || !api.storage.session) return {};
  const keys = [`tab:${tabId}`, `draft:${tabId}`];
  const got = await api.storage.session.get(keys).catch(() => ({}));
  const rec = got?.[keys[0]];
  const draft = got?.[keys[1]];
  return {
    record: rec && rec.url === tabUrl && rec.lakeId ? rec : null,
    draft: draft && draft.url === tabUrl && draft.text ? String(draft.text) : null,
  };
}

// The landed state, without the ceremony: no send, no turning mark, the
// chip already there. The note path is unchanged — it names the landing
// through the pageId the background filed it under.
function restore(rec) {
  if (rec.pageId) pageId = rec.pageId;
  answered = true;
  landed = true;
  landedPath = rec.refPath ?? null;
  setPageStatus("IN THE VAULT", "done");
  $("discuss").hidden = false;
}

// The draft outlives the popup — browsers close it on blur, and a half-typed
// note lost to a window switch was the second half of #300. Saved per tab,
// keyed to the url it was typed on, dropped when the note is sent.
let draftTimer = 0;
function saveDraft() {
  if (tabId == null || !tabUrl || !api.storage.session) return;
  clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 150);
}
// Written at once — the debounce above coalesces keystrokes, and the
// visibility hook below fires this when the popup is closing under you,
// so the last few characters are not what the blur takes.
function flushDraft() {
  clearTimeout(draftTimer);
  if (tabId == null || !tabUrl || !api.storage.session) return;
  const text = $("note").value;
  const key = `draft:${tabId}`;
  void (text ? api.storage.session.set({ [key]: { url: tabUrl, text } }) : api.storage.session.remove(key)).catch(
    () => {}
  );
}
function clearDraft() {
  clearTimeout(draftTimer);
  if (tabId == null || !api.storage.session) return;
  void api.storage.session.remove(`draft:${tabId}`).catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushDraft();
});

// One capture volley: send, and re-arm the no-answer backstop. Used by init
// and by the ALLOW THIS SITE retry.
function fireCapture() {
  answered = false;
  beginWork();
  api.runtime.sendMessage({ type: "bigbrain-popup-capture", tabId, pageId, url: tabUrl });
  clearTimeout(deadline);
  deadline = setTimeout(() => {
    if (answered) return;
    setPageStatus("NO ANSWER", "failed");
    setHints("THE CAPTURE NEVER REPORTED BACK", "failed");
    endWork();
  }, ANSWER_DEADLINE_MS);
}

function sendNote() {
  const note = $("note").value.trim();
  if (!note) return;
  setHints("SENDING NOTE…");
  beginWork();
  api.runtime.sendMessage({ type: "bigbrain-note", pageId, note });
}

$("discuss").addEventListener("click", discuss);

$("allow").addEventListener("click", () => {
  if (!blockedOrigin) return;
  // permissions.request must run inside the user-input handler — an await
  // before it voids the gesture in Firefox, so it is the first call here.
  api.permissions
    .request({ origins: [`${blockedOrigin}/*`] })
    .then((granted) => {
      if (!granted) return setHints("PERMISSION NOT GRANTED", "failed");
      blockedOrigin = null;
      $("allow").hidden = true;
      setPageStatus("SENDING");
      setHints(KEYS);
      fireCapture();
    })
    .catch(() => setHints("PERMISSION NOT GRANTED", "failed"));
});

$("note").addEventListener("input", saveDraft);

$("note").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  // No newline, ever: a note is a one-line directive to the gardener, and
  // Enter is how you send it. That frees Shift+Enter to mean exactly what
  // the chip's own ⇧↵ label says it means, in every state — a shortcut that
  // is a newline half the time is a shortcut that lies half the time.
  e.preventDefault();
  if (e.shiftKey) {
    if (landed) discuss();
    return;
  }
  sendNote();
});

// The same shortcut when the note well does not have focus.
window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || !e.shiftKey || !landed) return;
  if (e.target === $("note")) return;
  e.preventDefault();
  discuss();
});

init();
