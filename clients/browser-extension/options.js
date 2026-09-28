// options.js — pairing (#486). The engine on this machine shows a code on
// its integrations card; this page trades it for the browser's own
// credential: POST {endpoint}/v1/pair {code, client} → {token, name, owner}.
// The result lands in storage.local {endpoint, token} — the shape
// background.js reads — plus {account} (the owner's email, or the token's
// name) purely for this page's status line.
//
// The engine names the credential, not this page: `client` is what the
// browser calls itself (chrome, firefox…), the engine adds the machine, so
// the label in the app was minted, never typed. One code pairs one browser
// once; pairing again supersedes the old credential on the engine's side.
//
// The hosted Google sign-in that lived here answered to a service retired on
// 2026-08-26 (#566); background.js clears any credential it left behind.
//
// The card, the mark and the type are the popup's, from design.css. The mark
// turns while the request is in flight — it means the same thing here as it
// does there: something is in flight.

const api = globalThis.browser ?? globalThis.chrome;

const DEFAULT_ENDPOINT = "http://127.0.0.1:4748";

const $ = (id) => document.getElementById(id);

let mark = null;

function show(msg, ok) {
  const el = $("status");
  el.textContent = msg;
  el.className = `line is-${ok ? "done" : "failed"}`;
}

/** What this browser is, for the credential's name. Chromium-family browsers
 * say so in userAgentData; the rest is the UA string. Never the version. */
function browserName() {
  const brands = navigator.userAgentData?.brands ?? [];
  const brand = brands.find((b) => !/chromium|not.?a.?brand/i.test(b.brand))?.brand;
  if (brand) return brand.replace(/^google /i, "").toLowerCase();
  const ua = navigator.userAgent;
  if (/firefox\//i.test(ua)) return "firefox";
  if (/edg\//i.test(ua)) return "edge";
  if (/chrome\//i.test(ua)) return "chrome";
  if (/safari\//i.test(ua)) return "safari";
  return "browser";
}

/** The endpoint as typed, or the default; no trailing slash. Null when it
 * is not an http(s) URL at all. */
function endpointFrom(raw) {
  const t = (raw ?? "").trim() || DEFAULT_ENDPOINT;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return t.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Ask for the endpoint's origin as a host permission, from the click that
 * submitted the form (a permission prompt only rises from a user gesture).
 * Loopback is already granted in the manifest; any other endpoint needs
 * this so a background fetch there is not CORS-gated. Refusal is not
 * fatal — the engine answers CORS for any origin — so it is asked, not
 * required. */
async function grantOrigin(endpoint) {
  try {
    await api.permissions.request({ origins: [`${new URL(endpoint).origin}/*`] });
  } catch {
    /* not requestable here (a pattern the engine refuses, no gesture) */
  }
}

async function connect(event) {
  event.preventDefault();
  const endpoint = endpointFrom($("endpoint").value);
  const code = $("code").value.trim();
  if (!endpoint) return show("The BigBrain address must be an http:// or https:// URL.", false);
  if (!code) return show("Enter the code from BigBrain's integrations page.", false);

  $("connect").disabled = true;
  show("Pairing…", true);
  mark.spin();
  try {
    await grantOrigin(endpoint);
    const r = await fetch(`${endpoint}/v1/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, client: browserName() }),
    });
    if (r.status === 404) {
      // The route does not exist there: an engine older than pairing, or
      // a different engine from the one whose card showed the code (two
      // BigBrains on one machine answer on different ports). The bare
      // "not found" it sends says neither.
      throw new Error(
        `BigBrain at ${endpoint} answered, but it can't pair — an older engine, or not the one whose card showed this code. Use the address that card shows.`
      );
    }
    if (!r.ok) {
      let why = `the engine answered ${r.status}`;
      try {
        why = (await r.json()).error ?? why;
      } catch {
        /* no body */
      }
      throw new Error(why);
    }
    const { token, name, owner } = await r.json();
    if (!token) throw new Error("the engine returned no credential");
    await api.storage.local.set({ endpoint, token, account: owner || name || endpoint });
    $("code").value = "";
    show(`Paired as ${name}. You can start capturing pages.`, true);
    render();
  } catch (e) {
    const msg = String(e?.message ?? e);
    show(
      /failed to fetch|networkerror|load failed/i.test(msg)
        ? `Nothing answered at ${endpoint} — is BigBrain running on this machine?`
        : `Pairing failed: ${msg}`,
      false
    );
  }
  mark.settle();
  $("connect").disabled = false;
}

async function disconnect() {
  await api.storage.local.remove(["endpoint", "token", "account"]);
  show("Disconnected. This browser's credential stays on the engine until revoked in BigBrain's integrations.", true);
  render();
}

// Every line on this screen is a function of one bit — paired or not — so
// they are all set here together. Splitting them is how a card ends up
// telling you to pair underneath its own DISCONNECT button.
async function render() {
  const { endpoint, token, account } = await api.storage.local.get([
    "endpoint",
    "token",
    "account",
  ]);
  const connected = Boolean(endpoint && token);
  $("state").textContent = connected ? "CONNECTED" : "NOT CONNECTED";
  $("state").className = connected ? "eyebrow is-done" : "eyebrow";
  $("account").textContent = connected ? account || endpoint : "this machine";
  $("copy").textContent = connected
    ? "Click the toolbar button to capture the page you are on."
    : "Open BigBrain → settings → integrations, click PAIR A BROWSER, and enter the code here.";
  $("pair").hidden = connected;
  $("disconnect").hidden = !connected;
  if (!connected && !$("endpoint").value) $("endpoint").value = endpoint || DEFAULT_ENDPOINT;
}

mark = BigBrainCube.mount(document.querySelector(".cube-stage"));
$("pair").addEventListener("submit", connect);
$("disconnect").addEventListener("click", disconnect);
render();
