/** Public connection state. Tokens never enter this contract or a conversation. */
export interface GitHubRepository { name: string; id: number; access: "read" | "write" }
export interface GitHubStatus {
  connected: boolean;
  scope?: "account";
  account?: string;
  candidate?: string;
  repositories: GitHubRepository[];
  phase: "idle" | "checking" | "browser" | "ready" | "error";
  code?: string;
  url?: string;
  problem?: string;
}
export interface GitHubRequest {
  id: string; repository?: string; access?: "read" | "write"; reason: string;
  scope?: "account";
  reconnect?: boolean;
  inputId?: string;
  status: "pending" | "allowed" | "declined";
}
