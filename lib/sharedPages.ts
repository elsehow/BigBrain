/**
 * sharedPages.ts — every HTML page the shared door shows a person: the
 * connector's sign-in and consent (lib/sharedOAuth.ts), the join page, the
 * member's personal page, and the refusals. Pure functions from data to a
 * Response; the decisions live in lib/sharedOAuth.ts.
 *
 * They wear bigbrain.cool's look — its tokens, type ramp, buttons and the
 * wire mark — at the size of one short page: no web font from anywhere but
 * this door, no image, no animation, and one palette: the site's default
 * theme ("web" — blue ground, white ink, yellow activity), with no picker.
 *
 * Nothing loads from elsewhere. The CSP is `default-src 'none'` with the one
 * stylesheet and the one script pinned by hash, and fonts from 'self': the
 * door serves Hanken Grotesk itself at /assets/… (the extension's subsets,
 * embedded with `with { type: "file" }` so a compiled server binary carries
 * them too). The script only turns on Copy buttons; every page works
 * without it.
 *
 * Before sign-in a page says nothing about the vault behind it: no name, no
 * members, no counts. The vault's name appears only once a member is
 * signed in (consent, the personal page).
 */

import fontLatinPath from "../clients/browser-extension/fonts/hanken-grotesk-latin.woff2" with { type: "file" };
import fontLatinExtPath from "../clients/browser-extension/fonts/hanken-grotesk-latin-ext.woff2" with { type: "file" };
import { createHash } from "node:crypto";

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export const esc = (s: string): string =>
  s.replace(/[&<>"']/gu, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ── the font ────────────────────────────────────────────────────────────────

/** The two subsets a vault's names and emails plausibly need; the same
 * variable 400–600 files bigbrain.cool and the extension serve. */
const FONTS: Record<string, string> = {
  "/assets/hanken-grotesk-latin.woff2": fontLatinPath,
  "/assets/hanken-grotesk-latin-ext.woff2": fontLatinExtPath,
};
export const FONT_PATHS = Object.keys(FONTS);
const fontBytes = new Map<string, ArrayBuffer>();

/** A font file, immutable for a year — or undefined when `pathname` is not one. */
export async function fontResponse(pathname: string): Promise<Response | undefined> {
  const source = Object.hasOwn(FONTS, pathname) ? FONTS[pathname] : undefined;
  if (!source) return undefined;
  let bytes = fontBytes.get(pathname);
  if (!bytes) {
    bytes = await Bun.file(source).arrayBuffer();
    fontBytes.set(pathname, bytes);
  }
  return new Response(bytes, {
    headers: { "Content-Type": "font/woff2", "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" },
  });
}

// ── style, mark, script ─────────────────────────────────────────────────────

// Tokens and ramp from bigbrain.cool (assets/design.css, src/index.html),
// value for value where a page here has the same element. The three base
// colours are its `[data-theme="web"]`, what the site wears by default.
const STYLE = `
@font-face{font-family:"Hanken Grotesk";font-style:normal;font-weight:400 600;font-display:swap;src:url("/assets/hanken-grotesk-latin.woff2") format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"Hanken Grotesk";font-style:normal;font-weight:400 600;font-display:swap;src:url("/assets/hanken-grotesk-latin-ext.woff2") format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
:root{--bg:#1e2bd6;--fg:#ffffff;--activity:#ffd23f;--font-app:"Hanken Grotesk",system-ui,-apple-system,sans-serif;--font-mono:ui-monospace,Menlo,"SF Mono",monospace;--text-note:color-mix(in srgb,var(--fg) 88%,var(--bg));--text-muted:color-mix(in srgb,var(--fg) 65%,var(--bg));--surface:color-mix(in srgb,var(--fg) 4%,var(--bg));--rule:color-mix(in srgb,var(--fg) 18%,var(--bg));--r-sm:5px;--r-chip:11px;color-scheme:dark}
*{box-sizing:border-box}
::selection{background:color-mix(in srgb,var(--activity) 20%,var(--bg));color:var(--activity)}
[hidden]{display:none!important}
body{margin:0;padding:0 40px;background:var(--bg);color:var(--fg);font:400 15px/1.5 var(--font-app);-webkit-font-smoothing:antialiased}
a{color:inherit;text-underline-offset:4px}
a:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--activity);outline-offset:6px}
.wrap{max-width:720px;margin-inline:auto}
.top{min-height:112px;display:flex;align-items:center;border-bottom:1px solid var(--rule)}
.lockup{display:inline-flex;align-items:center;gap:20px;font:500 24px/1 var(--font-app);letter-spacing:-.022em}
.mark{display:block;width:48px;height:53px;flex:none}
.mark polygon{fill:var(--bg)}
.mark polygon,.mark path{stroke:var(--fg)}
main{padding:56px 0 72px}
.eyebrow{margin:0 0 24px;font:600 11px/1 var(--font-app);letter-spacing:.24em;text-transform:uppercase;color:var(--text-muted)}
h1{margin:0 0 22px;font:500 34px/1.12 var(--font-app);letter-spacing:-.03em}
h2{margin:0 0 13px;font:500 24px/1.2 var(--font-app);letter-spacing:-.022em}
p,ol,ul{margin:0 0 16px}
ol,ul{padding-left:22px}
li{margin:0 0 6px}
.lead{max-width:495px;color:var(--text-note);font:400 20px/1.5 var(--font-app)}
.meta{font-size:12px;color:var(--text-muted)}
.notice{padding:13px 16px;border:1px solid var(--activity);border-radius:var(--r-sm);background:color-mix(in srgb,var(--activity) 12%,var(--bg))}
section{padding:34px 0 18px;border-top:1px solid var(--rule)}
.actions{display:flex;flex-wrap:wrap;gap:13px;margin:26px 0 22px}
form{margin:0}
.cta{display:inline-flex;align-items:center;padding:16px 22px;background:var(--fg);color:var(--bg);border:1px solid var(--fg);border-radius:var(--r-chip);font:500 16px/1 var(--font-app);text-decoration:none;white-space:nowrap;cursor:pointer}
.cta:hover{background:var(--bg);color:var(--fg)}
.cta.secondary{background:var(--bg);color:var(--fg)}
.cta.secondary:hover{background:var(--fg);color:var(--bg)}
label{display:block;margin:0 0 9px;font-size:16px;font-weight:500;line-height:1.4}
input[type=text],input[type=password]{width:100%;min-width:0;padding:13px 14px;border:1px solid var(--rule);border-radius:var(--r-sm);background:var(--surface);color:var(--fg);font:16px/1.5 var(--font-app)}
.copy{display:flex;gap:13px;margin:0 0 16px}
.copy input{font:14px/1.5 var(--font-mono)}
@media(max-width:700px){body{padding-inline:22px}.top{min-height:96px}.lockup{font-size:23px}h1{font-size:28px}.lead{font-size:18px}.copy{flex-direction:column}}
`;

/** The wire mark, settled — the geometry of bigbrain.cool's mark, inked by
 * the page's own --fg and --bg. */
const MARK = `<svg class="mark" viewBox="-100 -110 200 220" aria-hidden="true" focusable="false"><g stroke-linejoin="miter" stroke-linecap="square" stroke-width="5"><polygon points="0,-80.23 -72.125,-44.167 0,-8.105 72.125,-44.167"/><path d="M-36.062,-62.199L36.062,-26.136" fill="none"/><path d="M36.062,-62.199L-36.062,-26.136" fill="none"/><polygon points="72.125,-44.167 72.125,44.167 0,80.23 0,-8.105"/><path d="M72.125,0L0,36.062" fill="none"/><path d="M36.062,-26.136L36.062,62.199" fill="none"/><polygon points="-72.125,-44.167 0,-8.105 0,80.23 -72.125,44.167"/><path d="M-36.062,-26.136L-36.062,62.199" fill="none"/><path d="M-72.125,0L0,36.062" fill="none"/></g></svg>`;

/** Reveals each hidden Copy button and copies its field. Without script the
 * field is still there to select. */
const SCRIPT = `for(const b of document.querySelectorAll("button[data-copy]")){const f=document.getElementById(b.dataset.copy);if(!f)continue;b.hidden=false;b.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(f.value);b.textContent="Copied";}catch{f.select();}});}`;

const hash = (s: string): string => createHash("sha256").update(s).digest("base64");

// No `form-action`: Chrome applies it to the redirect that FOLLOWS a form
// POST, and the consent POST's redirect goes to the client's redirect URI.
// Every form here posts to a fixed path of this origin.
export const PAGE_CSP = `default-src 'none'; style-src 'sha256-${hash(STYLE)}'; script-src 'sha256-${hash(SCRIPT)}'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'`;

const PAGE_HEADERS = {
  ...BASE_HEADERS,
  "Content-Type": "text/html; charset=utf-8",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": PAGE_CSP,
};

export function page(status: number, title: string, body: string, headers: Record<string, string> = {}): Response {
  const script = body.includes("data-copy=") ? `<script>${SCRIPT}</script>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${STYLE}</style></head><body><div class="wrap"><header class="top"><div class="lockup">${MARK}<span>BigBrain</span></div></header><main>${body}</main></div>${script}</body></html>`;
  return new Response(html, { status, headers: { ...PAGE_HEADERS, ...headers } });
}

const EYEBROW = `<p class="eyebrow">Shared BigBrain</p>`;

const hidden = (name: string, value: string): string => `<input type="hidden" name="${name}" value="${esc(value)}">`;

const copyField = (id: string, label: string, value: string): string =>
  `<label for="${id}">${esc(label)}</label><div class="copy"><input id="${id}" type="text" readonly value="${esc(value)}"><button class="cta secondary" type="button" data-copy="${id}" hidden>Copy</button></div>`;

// ── the pages ───────────────────────────────────────────────────────────────

export const refusalPage = (status: number, title: string, message: string): Response =>
  page(status, title, `${EYEBROW}<h1>${esc(title)}</h1><p class="lead">${esc(message)}</p>`);

/** The ONE page for every sign-in that does not reach a member: not a
 * member, bound to another account, removed, no read access. Which of
 * those it was goes to the server log, never to the visitor. */
export const notMemberPage = (): Response =>
  refusalPage(403, "Couldn't sign you in", "This Google account doesn't have access here. If you were invited, sign in with the Google account for the address you were invited with.");

export const expiredPage = (): Response =>
  refusalPage(400, "This sign-in has expired", "It may have timed out, or been started in a different browser. Start again from where you began.");

/** `/join` — identical for every visitor. */
export const joinPage = (): Response =>
  page(200, "Sign in to a shared BigBrain", `${EYEBROW}<h1>Sign in to a shared BigBrain</h1><div class="actions"><a class="cta" href="/join/google">Sign in with Google</a></div><p class="meta">Use the Google account for the address you were invited with.</p>`);

export interface AuthorizeView {
  clientName: string;
  redirectHost: string;
  loopback: boolean;
  /** Google sign-in for this authorization; when set, it is the only login. */
  googleHref?: string;
  /** The invite-link form, shown only when Google is not configured. */
  invite?: { pending: string; csrf: string };
  notice?: string;
}

export function authorizePage(v: AuthorizeView, status = 200): Response {
  const body = `${EYEBROW}<h1>Sign in to a shared BigBrain</h1>
${v.notice ? `<p class="notice">${esc(v.notice)}</p>` : ""}
<p class="lead"><strong>${esc(v.clientName)}</strong> is asking for read-only access. Afterwards you will return to <strong>${esc(v.redirectHost)}</strong>.</p>
${v.loopback ? `<p class="notice">That is an app on your own computer. Continue only if you just started this from Claude Code or another app you trust.</p>` : ""}
${v.googleHref ? `<div class="actions"><a class="cta" href="${esc(v.googleHref)}">Sign in with Google</a></div>` : ""}
${v.invite ? `<form method="post" action="/authorize/invite">${hidden("pending", v.invite.pending)}${hidden("csrf", v.invite.csrf)}
<label for="invite">Paste an invite link from the vault's owner</label>
<input id="invite" name="invite" type="password" autocomplete="off" required>
<div class="actions"><button type="submit" class="cta">Continue with invite link</button></div>
</form>
<p class="meta">An invite link works once: using it here means it can no longer connect the BigBrain app.</p>` : ""}
<p class="meta">This connection can only read; contributing happens in the BigBrain app.</p>`;
  return page(status, "Sign in to a shared BigBrain", body);
}

export interface ConsentView {
  clientName: string;
  vaultName: string;
  display: string;
  signedInAs: string;
  redirectHost: string;
  pending: string;
  csrf: string;
}

export function consentPage(v: ConsentView): Response {
  const body = `${EYEBROW}<h1>Allow ${esc(v.clientName)} to read ${esc(v.vaultName)}?</h1>
<p class="lead">Signed in as <strong>${esc(v.display)}</strong> (${esc(v.signedInAs)}).</p>
<ul><li>It can read this vault's evidence, claims and change feed, as you.</li><li>It cannot add, change or withdraw anything.</li><li>You will return to <strong>${esc(v.redirectHost)}</strong>.</li></ul>
<form method="post" action="/authorize/consent">${hidden("pending", v.pending)}${hidden("csrf", v.csrf)}
<div class="actions"><button type="submit" name="decision" value="approve" class="cta">Allow read-only access</button><button type="submit" name="decision" value="deny" class="cta secondary">Deny</button></div>
</form>
<p class="meta">The vault's owner can revoke this access at any time.</p>`;
  return page(200, `Allow access to ${v.vaultName}`, body);
}

export interface MeView {
  vaultName: string;
  email: string;
  canWrite: boolean;
  connectorUrl: string;
  csrf: string;
  /** A just-created app link, shown once. */
  appLink?: string;
}

/** `/me` — what a signed-in member can do from a browser. */
export function mePage(v: MeView): Response {
  const body = `${EYEBROW}<h1>${esc(v.vaultName)}</h1>
<p class="lead">Signed in as ${esc(v.email)}. You can ${v.canWrite ? "read and contribute" : "read this vault"}.</p>
<section aria-labelledby="claude"><h2 id="claude">Use with Claude</h2>
<p>Add this vault to Claude as a connector. Claude can then search and read it in your conversations; it can't change anything.</p>
${copyField("connector", "Connector URL", v.connectorUrl)}
<ol><li>In Claude, open Settings → Connectors and choose Add custom connector.</li><li>Paste the URL and add it.</li><li>Choose Connect, and sign in with Google when asked.</li></ol>
</section>
<section aria-labelledby="app"><h2 id="app">Connect the BigBrain app</h2>
<p>Create a link for each device, then paste it into BigBrain under Connect vault. Each link works once, within an hour.</p>
${v.appLink ? copyField("app-link", "App link", v.appLink) : ""}
<form method="post" action="/me/app-link">${hidden("csrf", v.csrf)}<div class="actions"><button type="submit" class="cta">${v.appLink ? "Create another app link" : "Create an app link"}</button></div></form>
</section>
<section><form method="post" action="/me/signout">${hidden("csrf", v.csrf)}<button type="submit" class="cta secondary">Sign out</button></form></section>`;
  return page(200, v.vaultName, body);
}
