/**
 * servers.ts — follow every joined server into this computer's copy of it
 * (lib/serverStore.ts): when a server's change feed has moved, page in what
 * changed, so no read waits on the network. Run by the supervisor on the
 * `servers` cadence (lib/desktopSchedule.ts).
 *
 * Usage: bun bin/servers.ts
 */
import { followServers } from "../lib/serverStore";
import { connectionStorePath } from "../lib/sharedConnections";

await followServers(connectionStorePath());
