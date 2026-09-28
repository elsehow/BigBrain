/** Read-only credential checks. No polling, admission, or remembered evidence. */
import { emailConfig, passwordEnvKey } from "./emailConfig";
import { loadManifest } from "./manifest";
import { readEnvValues } from "./envFile";
import { probeInbox, type InboxProbe } from "./imapProbe";
import { ThatTracksClient } from "./thatTracks";
export async function checkIntegrationConnection(root: string, name: string, probe: InboxProbe = probeInbox,
  tracks: (key: string) => Promise<unknown> = key => new ThatTracksClient(key).identity()): Promise<void> {
  const env = readEnvValues(root);
  if (name === "email") {
    const accounts = emailConfig(loadManifest(root).integrations.email).inboxes;
    if (!accounts.length) throw new Error("Add an inbox before activating email.");
    for (const account of accounts) {
      const password = env[passwordEnvKey(account.address)];
      if (!password) throw new Error("An inbox needs its password before activation.");
      await probe({ ...account, password });
    }
  } else if (name === "granola") {
    throw new Error("Connect Granola with browser sign-in in Settings → Integrations.");
  } else if (name === "that-tracks") {
    const key = env["THAT_TRACKS_API_KEY"];
    if (!key) throw new Error("Save an API key before activating.");
    await tracks(key);
  } else throw new Error("This integration has no access-check adapter.");
}
