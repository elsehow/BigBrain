/** Historical permission record shapes, retained only to decode saved conversations. */
import type { FolderAccess } from "./workPermissions";
import { z } from "zod";
export interface SessionGrant extends FolderAccess { id: string; source: "settings" | "user"; authorization?: string }
export interface AccessRequest extends FolderAccess {
  id: string; reason: string; revision: number; status: "pending" | "approved" | "declined" | "applied" | "canceled";
  created: string; source?: "settings" | "user"; authorization?: string; announced?: boolean;
}
export interface SessionAccess {
  revision: number; appliedRevision?: number; unrestricted: boolean; grants: SessionGrant[];
  requests: AccessRequest[]; history: { at: string; text: string }[];
  // An interrupted change remains reviewable after restart; never auto-replay work.
  changing?: boolean;
  revoked: FolderAccess[];
}
const folder = z.object({ path: z.string(), access: z.enum(["read", "write"]) }).passthrough();
/** Validate saved authority before exposing it to either runtime or UI. Never repair grants by guessing. */
export const sessionAccessSchema = z.object({
  revision: z.number().int().nonnegative(), unrestricted: z.boolean(),
  grants: z.array(folder.extend({ id: z.string(), source: z.enum(["settings", "user"]) })),
  requests: z.array(folder.extend({ id: z.string(), reason: z.string(), revision: z.number(), created: z.string(),
    status: z.enum(["pending", "approved", "declined", "applied", "canceled"]) })),
  history: z.array(z.object({ at: z.string(), text: z.string() }).passthrough()), revoked: z.array(folder),
}).passthrough();
