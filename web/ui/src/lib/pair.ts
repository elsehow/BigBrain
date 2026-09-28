import { vaultFetch as fetch } from "./vaultScope";
/**
 * pair.ts — the browser card's client (#486): the pairing code the engine
 * mints, the endpoint a browser should point at, and which credentials are
 * browsers. The engine's half is lib/pair.ts; the extension's is
 * clients/browser-extension/options.js.
 *
 * A browser exists, from here, exactly when its credential does — the app
 * is a webview and cannot see an extension, so the list on the card is the
 * token store filtered by provenance (`via: "pair"`), and "last capture" is
 * the token's `last_used`.
 */

import type { Connection } from "./connect";

/** Existing store listings retain their URLs across extension updates. */
export const CHROME_EXTENSION_URL = "https://chromewebstore.google.com/detail/send-to-bigbrain/ddnflabpbjfcakilfjmbinhblgbmckpb";
export const FIREFOX_EXTENSION_URL = "https://addons.mozilla.org/en-US/firefox/addon/send-to-bigbrain/";

export interface PendingPair {
  code: string;
  created: string;
  expires: string;
}

export interface PairState {
  /** The API base the extension's options page should be told. */
  endpoint: string;
  /** The code outstanding, or null: none minted, or the last one expired or was spent. */
  pending: PendingPair | null;
}

/** A browser the person paired here. Provenance, not shape — see
 * `isConnection` in connect.ts for why `kind` is the wrong test. */
export const isBrowser = (c: Connection): boolean => c.via === "pair";

/** `null` ⇒ no such route here (an older host's viewer, or offline). */
export async function pairState(): Promise<PairState | null> {
  try {
    const r = await fetch("/api/pair", { headers: { Accept: "application/json" } });
    if (!r.ok) return null;
    return (await r.json()) as PairState;
  } catch {
    return null;
  }
}

/** Mint a fresh code — THIS is the authorizing act: nothing exists until
 * the click, and the code dies in ten minutes or on first use. */
export async function mintPair(): Promise<PairState> {
  const r = await fetch("/api/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error(`could not mint a code (${r.status})`);
  return (await r.json()) as PairState;
}

/** Seconds a pending code has left; 0 once it is gone. */
export const secondsLeft = (p: PendingPair, now: number = Date.now()): number =>
  Math.max(0, Math.round((Date.parse(p.expires) - now) / 1000));
