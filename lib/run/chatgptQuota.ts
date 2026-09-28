import { quotaJson } from "./quotaHttp";
/** Optional account observation using the same Pi OAuth identity as inference.
 * Wire format follows openai/codex's backend-client rate_limit_resets.rs.
 * This compatibility endpoint may change; missing quota never blocks work. */
import { sha256hex } from "../hash";
import type { QuotaSample } from "./monitorTypes";

/** Decode only for correlation; this is not token verification. Pi and the
 * provider own authentication. Never journal the token or raw account ID. */
export function chatgptAccount(token: string | undefined): string | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token!.split(".")[1]!, "base64url").toString("utf8"));
    const id = claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch { return undefined; }
}
export const chatgptAccountHash = (id: string): string => sha256hex(`openai-codex:${id}`);

export function quotaWindows(value: any): QuotaSample[] {
  const buckets: [string, any][] = [["codex", value?.rate_limit],
    ...(Array.isArray(value?.additional_rate_limits) ? value.additional_rate_limits.map((b: any) => [b.metered_feature ?? b.limit_name, b.rate_limit] as [string, any]) : [])];
  const out: QuotaSample[] = [];
  for (const [id, bucket] of buckets) for (const name of ["primary_window", "secondary_window"] as const) {
    const w = (bucket as any)?.[name];
    if (!w || typeof w.used_percent !== "number" || !Number.isFinite(w.used_percent) || w.used_percent < 0 || w.used_percent > 100 ||
      typeof w.reset_at !== "number" || !Number.isFinite(w.reset_at) || Math.abs(w.reset_at * 1000) >= 8.64e15) continue;
    const duration = w.limit_window_seconds / 60;
    const window = duration === 300 ? "five_hour" : duration === 10080 ? "seven_day" :
      typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? `${duration}_minutes` : name;
    out.push({ kind: "quota", window: id === "codex" ? window : `${String(id)}_${window}`, used: w.used_percent / 100, resetsAt: new Date(w.reset_at * 1000).toISOString() });
  }
  return out;
}

export type QuotaReader = (token: string, signal: AbortSignal) => Promise<QuotaSample[]>;
export async function readChatgptQuota(token: string, signal: AbortSignal,
  request: typeof fetch = fetch): Promise<QuotaSample[]> {
  const account = chatgptAccount(token);
  if (!account || signal.aborted) return [];
  try {
    const value = await quotaJson("https://chatgpt.com/backend-api/wham/usage", {
      Authorization: `Bearer ${token}`, "ChatGPT-Account-Id": account,
    }, signal, request);
    return quotaWindows(value)
      .map(q => ({ ...q, accountId: chatgptAccountHash(account), at: new Date().toISOString() }));
  } catch { return []; }
}
