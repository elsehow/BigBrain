/** Wire types shared by the desktop engine and its browser UI.
 *
 * Keeping these shapes outside the server implementation prevents the two
 * sides from growing subtly different ideas of what Pilot is configured or
 * enabled to do.  This file must stay free of Node-only imports at runtime.
 */
export type PilotStatus = "unconfigured" | "disabled" | "ready";

export type PilotPermissions = import("./workPermissions").WorkPermissions;

export interface PilotState {
  /** API key is saved, independently of the enabled switch. */
  configured: boolean;
  enabled: boolean;
  /** Explicit lifecycle state used by settings and the HUD. */
  status: PilotStatus;
  model: string;
  voice: string;
  permissions?: PilotPermissions;
}

export interface PilotSecret {
  value: string;
  expires_at: number;
  model: string;
}
