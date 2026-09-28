import type { ChatImage } from "./chatImageTypes";
/** Approval is valid only while this engine owns the browser resources. */
export interface PilotBrowserState {
  status: "pending" | "allowed" | "declined";
  requestId: string;
  reason: string;
  preview?: { url: string; directory: string; title: string };
  screenshot?: ChatImage;
  error?: string;
}
