/**
 * imapProbe.ts — one IMAP login, to learn whether an inbox's credentials
 * work, and the words a failure is reported in. Two callers: the settings
 * screen's SAVE on ADD AN INBOX (lib/configWrite.ts), which refuses to
 * write a credential that does not log in, and the poller
 * (integrations/email/run.ts), whose row says the same words when a
 * password stops working later.
 */

import { ImapFlow } from "imapflow";

export interface ImapTarget {
  address: string;
  host: string;
  port?: number;
  password: string;
}

/** What went wrong, in the row's words. */
export function friendlyImapError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const anyE = e as { authenticationFailed?: boolean; code?: string; responseText?: string };
  if (
    anyE?.authenticationFailed ||
    /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/iu.test(`${msg} ${anyE?.responseText ?? ""}`)
  )
    return "password rejected";
  if (anyE?.code === "ENOTFOUND" || /ENOTFOUND|getaddrinfo/u.test(msg)) return "host not found";
  if (anyE?.code === "ECONNREFUSED") return "connection refused";
  if (/ETIMEDOUT|timeout|timed out/iu.test(msg)) return "no answer from host";
  return msg.split("\n")[0]!.slice(0, 120) || "connection failed";
}

/** Log in and out again. Resolves when the server accepted the password;
 * rejects with the friendly words otherwise. Bounded: a host that never
 * answers is "no answer from host" after `timeoutMs`, not a hung form. */
export async function probeInbox(t: ImapTarget, timeoutMs = 15_000, gmail = false): Promise<void> {
  const client = new ImapFlow({
    host: t.host,
    port: t.port ?? 993,
    secure: true,
    auth: { user: t.address, pass: t.password },
    logger: false,
    emitLogs: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
  client.on("error", () => {}); // a late socket error after our logout is not news
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async()=>{
        await client.connect();
        if(gmail) {
          if(!client.capabilities.has('X-GM-EXT-1'))throw Error('Gmail IMAP extensions are unavailable.');
          const all=(await client.list()).find(b=>b.specialUse==='\\All');
          if(!all)throw Error('Show All Mail in Gmail IMAP settings, then reconnect.');
          const lock=await client.getMailboxLock(all.path,{readOnly:true});lock.release();
        }
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out")), timeoutMs);
      }),
    ]);
  } catch (e) {
    if(gmail) {
      const message=e instanceof Error?e.message:'';
      throw Error(message.startsWith('Show All Mail')||message.startsWith('Gmail IMAP extensions')?message:'Could not connect to Gmail. Check the app password and account IMAP access.');
    }
    throw new Error(friendlyImapError(e));
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}

/** The probe's shape, so a caller can be handed a stub in tests. */
export type InboxProbe = (t: ImapTarget) => Promise<void>;
export const probeGmail:InboxProbe=t=>probeInbox(t,15_000,true);
