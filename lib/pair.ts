/**
 * pair.ts — pairing a browser extension with this machine's vault (#486).
 *
 * The extension is the one client the engine cannot see: the desktop app is
 * a webview, not a browser, and a page inside it has no way to ask what
 * extensions are installed. So a browser exists, from the engine's side,
 * exactly when its credential does — one token per browser, named for it
 * (`chrome on Mac-mini.local`), stamped `via: pair`, and touched on every
 * capture. The integrations card lists those tokens; that IS the list of
 * connected browsers, and `last_used` is the last capture.
 *
 * Handing the credential over takes one paste, on purpose. Any web page
 * can POST to 127.0.0.1:4748, so a mint route with no secret would let a
 * page pair itself; the secret is a short code the person carries by hand
 * from the app to the extension's options page:
 *
 *   app        POST /api/pair            → mints a code, shows it (web/server.ts)
 *   extension  POST /v1/pair {code, client} → the code, once, for a token (lib/api.ts)
 *
 * The code is eight characters from a 32-letter alphabet (no 0/O/1/I),
 * lives ten minutes, and dies on first use or on its tenth miss — a page
 * guessing at loopback gets ten tries against 2^40, every miss costs it a
 * delay, and the person mints a fresh code if a guesser spent theirs. The
 * engine names the token, not the extension: the browser says
 * what it is (`chrome`, `firefox`), the engine adds the machine, so the
 * label in the app was minted, never typed.
 *
 * The pending code lives in the vault's `.state/` (gitignored, mode 600)
 * because two processes share it — the web server mints, the API redeems —
 * and it is a ten-minute secret for a person's own machine, not a
 * credential: the token store keeps hashes; this keeps a code the card
 * can show again after the person walks to their browser and back.
 */

import { randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { listTokens, mintToken, revokeToken, tokenStorePath, type TokenRecord } from "./auth";
import { machineLabel } from "./connect";
import { writeAtomic } from "./fsx";

/** How long a minted code is good for. */
export const PAIR_TTL_MS = 10 * 60_000;
/** Wrong codes one pending code survives; the last one spends it. */
export const PAIR_MAX_MISSES = 10;
/** What a browser needs: drop pages, queue a note about them. Never read. */
const PAIR_SCOPES = ["inbox:write"] as const;

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LEN = 8;

export const pairFile = (root: string): string => join(root, ".state", "pairing.json");

export interface PendingPair {
  /** Shown as `XXXX-XXXX`; compared without the dash, case-folded. */
  code: string;
  created: string;
  expires: string;
}

/** On disk the code also counts the misses against it. */
interface StoredPair extends PendingPair {
  misses: number;
}

const canon = (code: string): string => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function readPending(root: string): StoredPair | null {
  const file = pairFile(root);
  if (!existsSync(file)) return null;
  try {
    const p = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredPair>;
    return typeof p.code === "string" && typeof p.expires === "string" && typeof p.created === "string"
      ? { code: p.code, created: p.created, expires: p.expires, misses: typeof p.misses === "number" ? p.misses : 0 }
      : null;
  } catch {
    return null;
  }
}

const writePending = (root: string, p: StoredPair): void =>
  writeAtomic(pairFile(root), JSON.stringify(p, null, 2) + "\n", 0o600);

function clearPending(root: string): void {
  try {
    unlinkSync(pairFile(root));
  } catch {
    /* already gone */
  }
}

/** Mint a fresh code, replacing any pending one — there is only ever one
 * code outstanding, so a person who lost the first just mints again. */
export function mintPairCode(root: string, now: Date = new Date()): PendingPair {
  let raw = "";
  for (let i = 0; i < CODE_LEN; i++) raw += ALPHABET[randomInt(ALPHABET.length)];
  const pending: PendingPair = {
    code: `${raw.slice(0, 4)}-${raw.slice(4)}`,
    created: now.toISOString(),
    expires: new Date(now.getTime() + PAIR_TTL_MS).toISOString(),
  };
  writePending(root, { ...pending, misses: 0 });
  return pending;
}

/** The code outstanding, if one is and it is still good. An expired one is
 * removed on the way out, so the file never outlives its ten minutes by
 * more than the next look. */
export function pendingPair(root: string, now: Date = new Date()): PendingPair | null {
  const p = livePending(root, now);
  return p && { code: p.code, created: p.created, expires: p.expires };
}

function livePending(root: string, now: Date = new Date()): StoredPair | null {
  const p = readPending(root);
  if (!p) return null;
  if (Date.parse(p.expires) <= now.getTime()) {
    clearPending(root);
    return null;
  }
  return p;
}

/** What the extension says it is → the first word of its token name. Lower
 * case letters, digits and spaces only, short, never empty: the name is
 * shown in the app and stamped on every clip it sends. */
export function normalizeClient(raw: unknown): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20)
    .trim();
  return s || "browser";
}

/** `chrome on <machine>` — the browser-side twin of connectTokenName. */
export function browserTokenName(client: string, machine: string = hostname()): string {
  const host = machineLabel(machine);
  const c = normalizeClient(client);
  return host ? `${c} on ${host}` : c;
}

export interface RedeemResult {
  token: string;
  record: TokenRecord;
  /** Same-name live tokens revoked by this pairing (a browser pairing again). */
  superseded: string[];
}

/** Trade the pending code for a credential. Null when there is no pending
 * code, it has expired, or `code` is not it — one answer for all three, so
 * a guesser learns nothing. A miss counts against the code, and the
 * PAIR_MAX_MISSES-th spends it. On success the code is spent, any live token
 * already named for this browser on this machine is superseded, and a
 * person-device token is minted in the owner's name: clips land as the
 * person's own, which is what a page they chose to keep is. */
export function redeemPairCode(
  root: string,
  code: string,
  client: string,
  opts: { owner: string; storePath?: string; machine?: string; now?: Date }
): RedeemResult | null {
  const pending = livePending(root, opts.now);
  if (!pending) return null;
  const want = Buffer.from(canon(pending.code));
  const got = Buffer.from(canon(code));
  if (want.length !== got.length || !timingSafeEqual(want, got)) {
    const misses = pending.misses + 1;
    if (misses >= PAIR_MAX_MISSES) clearPending(root);
    else writePending(root, { ...pending, misses });
    return null;
  }
  clearPending(root);

  const storePath = opts.storePath ?? tokenStorePath(root);
  const name = browserTokenName(client, opts.machine);
  const superseded = listTokens(storePath)
    .filter((t) => t.name === name && !t.revoked)
    .map((t) => t.id);
  for (const id of superseded) revokeToken(storePath, id);
  const { token, record } = mintToken(storePath, root, name, [...PAIR_SCOPES], {
    owner: opts.owner,
    kind: "person-device",
    via: "pair",
  });
  return { token, record, superseded };
}
