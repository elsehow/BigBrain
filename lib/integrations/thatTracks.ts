/** That Tracks: a poller with a read key per account (lib/thatTracks.ts). No live tools. */
import { readEnvValues } from "../envFile";
import { sha256hex } from "../hash";
import { accountEnvKey, extraAccounts, type Integration } from "./contract";

const envKey = (account: string) => accountEnvKey("THAT_TRACKS_API_KEY", "that-tracks", account);

export const thatTracks: Integration = {
  id: "that-tracks",
  name: "That Tracks",
  credential: { kind: "api-key", envKey },
  accounts: root => ["that-tracks", ...extraAccounts(root, "that-tracks").map(a => a.id)],
  fingerprint: (root, account) => sha256hex(JSON.stringify([account, readEnvValues(root)[envKey(account)]])),
  tools: [],
};
