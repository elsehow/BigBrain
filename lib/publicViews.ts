/** Allowlisted projections: storage additions cannot become HTTP fields. */
export function fields<T, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]])) as Pick<T, K>;
}
export const imageView = (v: import("./chatImageTypes").ChatImage) => fields(v, ["id", "name"]);
export const outputView = (v: import("./workOutputs").WorkOutput) => fields(v, ["id", "path", "title", "at", "kind", "status"]);
export const notificationView = (v: import("./pilotNotifications").PilotNotification) => fields(v, ["id", "pilotId", "pilotTitle", "messageId", "key", "text", "kind", "at", "seen", "dismissed", "resolved", "workerRequest"]);
export const grantView = (v: import("./workerHistoryTypes").ProjectGrant) => ({ ...fields(v, ["path", "mode", "references", "domains", "network", "credentials"]), accounts: v.accounts.map(a => fields(a, ["integration", "account"])) });
