/** Email checkpoint preservation and settings status, above configuration parsing. */
import { passwordEnvKey, type EmailConfig } from "./emailConfig";
import { join } from "node:path";
import { preserveStaged } from "./stageStorage";
import { ensureSpool, spoolDir } from "./spool";
import { readEnvValues } from "./envFile";
import { writeAtomic } from "./fsx";
import { integrationStateFile, readCursorJson } from "./integrationCursor";

// ── the poller's durable source checkpoint ─────────────────────────────

export interface InboxState {
  /** IMAP's own generation counter for the mailbox: when it changes, every
   * UID we remember is meaningless and the cursor re-inits. */
  uidvalidity?: number;
  since?: string;
  backfillRequest?: string;
  failed?: { uid: number; reason: string }[];
  /** The highest UID processed. */
  lastUid?: number;
  /** The mailbox polled — Gmail's All Mail where the server has one. */
  mailbox?: string;
  /** UIDs whose body the last poll could not fetch or parse, and how many
   * times it has tried; the next poll asks again, a few times. */
  retry?: { uid: number; tries: number }[];
  last?: { at: string; ok: boolean; error?: string };
}

export interface EmailState {
  inboxes: Record<string, InboxState>;
}

export const emailStateFile = (root: string): string => join(spoolDir(root), "email.json");

export function readEmailState(root: string): EmailState {
  preserveStaged(root);
  const saved = readCursorJson(emailStateFile(root));
  const legacy = saved ? undefined : readCursorJson(integrationStateFile("email", root));
  if (legacy) {
    ensureSpool(root);
    writeAtomic(emailStateFile(root), `${JSON.stringify(legacy)}\n`);
  }
  const raw = saved ?? legacy ?? {};
  const inboxes =
    raw["inboxes"] && typeof raw["inboxes"] === "object" && !Array.isArray(raw["inboxes"])
      ? (raw["inboxes"] as Record<string, InboxState>)
      : {};
  return { inboxes };
}

export function writeEmailState(root: string, state: EmailState): void {
  preserveStaged(root);
  ensureSpool(root);
  writeAtomic(emailStateFile(root), `${JSON.stringify(state, null, 2)}\n`);
}

// ── what the settings screen shows ──────────────────────────────────────────

export interface InboxSource {
  id: string;
  label: string;
  status: "ok" | "unset" | "failed";
  detail?: string;
  fields: Record<string, string>;
}

function ago(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** One line per inbox: the last poll's word as a status, and the reason
 * when it is not ok. `fields` lets FIX open the add form with everything
 * but the password filled. */
export function emailSources(root: string, cfg: EmailConfig, now = new Date()): InboxSource[] {
  const env = readEnvValues(root);
  const state = readEmailState(root);
  return cfg.inboxes.map((i) => {
    const fields = { address: i.address, host: i.host };
    const base = { id: i.address, label: i.address, fields };
    if (!env[passwordEnvKey(i.address)]) return { ...base, status: "unset", detail: "no password" };
    const last = state.inboxes[i.address]?.last;
    if (last && !last.ok)
      return { ...base, status: "failed", detail: `${last.error ?? "poll failed"} · ${ago(last.at, now)}` };
    return { ...base, status: "ok" };
  });
}

