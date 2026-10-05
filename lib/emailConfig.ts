/**
 * emailConfig.ts — the email integration's configuration surface (#744):
 * which inboxes the poller reads, where their app passwords live, and the
 * row the settings screen shows for each inbox.
 *
 * vault.yaml holds what is safe to commit — an inbox is an address and an
 * IMAP host — and the vault's .env holds the app password under a key
 * derived from the address (lib/envFile.ts), never the yaml.
 *
 *   integrations:
 *     email:
 *       inboxes:
 *         - address: you@example.com
 *           host: imap.gmail.com
 *
 * A `skip:` list there (the retired skip rules) is left alone and ignored:
 * the worth gate decides what is worth gardening now (lib/worthGate.ts).
 * Nothing here touches the network; the poller (integrations/email/run.ts)
 * does that, and stages what it finds (lib/stage.ts).
 */

import { loadManifest } from "./manifest";
import { YAMLMap, type Document } from "yaml";

export interface Inbox {
  address: string;
  host: string;
  port: number;
  /** Written by Gmail onboarding, whose consent is read-only: only these
   * are forcibly read-only. An unflagged inbox at imap.gmail.com keeps its
   * IMAP write access; isGmailInbox tells the two apart for display. */
  provider?: "gmail";
}

export interface EmailConfig {
  inboxes: Inbox[];
}

export const ADDRESS_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/u;
export const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/iu;

/** The .env key an inbox's app password lives under. Derived, so the
 * settings screen can set it and the poller can read it without either
 * ever listing keys. */
export function passwordEnvKey(address: string): string {
  return `BIGBRAIN_IMAP_PASSWORD__${address.trim().toUpperCase().replace(/[^A-Z0-9]/gu, "_")}`;
}

/** The add form the settings screen shows — the three things IMAP needs. */
export const INBOX_ADD = {
  label: "ADD AN INBOX",
  noun: "inbox",
  fields: [
    { key: "address", label: "address", secret: false, placeholder: "you@example.com" },
    // prefilled, not hinted: right for most people, and a hint reads as
    // "type this" — one tester typed imap.google.com (2026-09-04)
    { key: "host", label: "imap host", secret: false, default: "imap.gmail.com" },
    { key: "password", label: "app password", secret: true },
  ],
} as const;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim() : undefined;

/** The email block of vault.yaml, read tolerantly: a malformed inbox or
 * rule is dropped, never fatal — the file is hand-edited by contract. */
export function emailConfig(block: Record<string, unknown> | undefined): EmailConfig {
  const b = block ?? {};
  const inboxes: Inbox[] = [];
  for (const raw of Array.isArray(b["inboxes"]) ? b["inboxes"] : []) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const address = str(r["address"])?.toLowerCase();
    const host = str(r["host"]);
    if (!address || !ADDRESS_RE.test(address) || !host) continue;
    const port = typeof r["port"] === "number" && r["port"] > 0 ? Math.floor(r["port"]) : 993;
    if (!inboxes.some((i) => i.address === address)) inboxes.push({ address, host, port, ...(r["provider"] === "gmail" ? { provider: "gmail" as const } : {}) });
  }
  return { inboxes };
}

// ── the settings screen's writes: add / remove an inbox ─────────────────────

/** An inbox at Google's IMAP host, flagged by Gmail onboarding or not. The
 * earlier generic add form wrote the same host without the flag, and such an
 * inbox was invisible to the Gmail settings while still blocking its address
 * from being added again (2026-09-25). Presentation and app-password
 * hygiene only: the read-only rule is gmailReadOnly, which needs the flag. */
export function isGmailInbox(inbox: Pick<Inbox, "host" | "provider">): boolean {
  return inbox.provider === "gmail" || inbox.host.trim().toLowerCase() === "imap.gmail.com";
}

export function gmailReadOnly(root: string, address: string): boolean {
  return emailConfig(loadManifest(root).integrations.email).inboxes.some(i => i.address === address && i.provider === "gmail");
}

export interface InboxAdd {
  provider?: "gmail";
  address: string;
  host: string;
  password: string;
}

const hasControl = (v: string): boolean =>
  [...v].some((c) => {
    const n = c.codePointAt(0) ?? 0;
    return n < 0x20 || n === 0x7f;
  });

/** The add form's fields, checked. Every message here is shown to the
 * person who typed the form. */
export function parseInboxAdd(add: Record<string, unknown>): InboxAdd {
  const address = str(add["address"])?.toLowerCase();
  const host = str(add["host"])?.toLowerCase();
  const password = typeof add["password"] === "string" ? add["password"] : "";
  if (!address || !ADDRESS_RE.test(address)) throw new Error("address must be an email address");
  if (!host || !HOST_RE.test(host)) throw new Error("imap host must be a hostname, like imap.gmail.com");
  if (!password.trim()) throw new Error("app password is required");
  if (hasControl(password)) throw new Error("app password must not contain control characters");
  return { address, host, password, ...(add["provider"] === "gmail" ? {provider: "gmail" as const} : {}) };
}

/** The `integrations.email` map of the document, created when missing. */
function emailMap(doc: Document): YAMLMap {
  // setIn stores a plain value as given — a `{}` stays an Object, not a
  // YAMLMap — so the nodes are created explicitly
  if (!(doc.getIn(["integrations"], true) instanceof YAMLMap)) doc.setIn(["integrations"], doc.createNode({}));
  let m = doc.getIn(["integrations", "email"], true);
  if (!(m instanceof YAMLMap)) {
    doc.setIn(["integrations", "email"], doc.createNode({}));
    m = doc.getIn(["integrations", "email"], true);
  }
  const map = m as YAMLMap;
  map.flow = false; // `email: {}` was fine for an empty entry; a list is not
  return map;
}

const currentInboxes = (doc: Document): Record<string, unknown>[] => {
  const raw = doc.getIn(["integrations", "email", "inboxes"]);
  const list = raw && typeof (raw as { toJSON?: unknown }).toJSON === "function" ? (raw as { toJSON: () => unknown }).toJSON() : raw;
  return Array.isArray(list) ? list.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [];
};

/** Add an inbox to vault.yaml (or re-credit one: the same address replaces
 * its host). The password is the caller's to put in .env. */
export function applyInboxAdd(doc: Document, add: InboxAdd): { changed: boolean; summary: string } {
  const list = currentInboxes(doc);
  const at = list.findIndex((i) => str(i["address"])?.toLowerCase() === add.address);
  const entry = { address: add.address, host: add.host, ...(add.provider ? {provider: add.provider} : {}) };
  if (at >= 0) {
    if (str(list[at]!["host"])?.toLowerCase() === add.host)
      return { changed: false, summary: `inbox ${add.address} re-credited` };
    list[at] = { ...list[at], ...entry };
  } else list.push(entry);
  emailMap(doc).set("inboxes", doc.createNode(list));
  return { changed: true, summary: `inbox ${add.address} ${at >= 0 ? "updated" : "added"}` };
}

export function applyInboxRemove(doc: Document, address: string): { changed: boolean; summary: string } {
  const a = address.trim().toLowerCase();
  const list = currentInboxes(doc);
  const kept = list.filter((i) => str(i["address"])?.toLowerCase() !== a);
  if (kept.length === list.length) return { changed: false, summary: `inbox ${a} was not listed` };
  emailMap(doc).set("inboxes", doc.createNode(kept));
  return { changed: true, summary: `inbox ${a} removed` };
}
