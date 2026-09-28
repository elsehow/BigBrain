import { z } from "zod";
import type { ProjectGrant } from "./projects";

/** A model may propose access; only the user's approval route can grant it. */
export const environmentProposalSchema = z.object({
  label: z.string().trim().min(1).max(100),
  mode: z.enum(["read", "work"]),
  references: z.array(z.string()).max(20).default([]),
  domains: z.array(z.string()).max(30).default([]),
  network: z.literal("public").optional(),
  credentials: z.array(z.string()).max(30).default([]),
  accounts: z.array(z.object({ integration: z.enum(["email", "granola"]), account: z.string() }).strict()).max(30).default([]),
}).strict();
export const environmentProposalParameters = {
  type: "object", properties: {
    label: { type: "string" }, mode: { type: "string", enum: ["read", "work"] },
    references: { type: "array", items: { type: "string" } },
    domains: { type: "array", items: { type: "string" } },
    network: { type: "string", enum: ["public"] },
    credentials: { type: "array", items: { type: "string" } },
    accounts: { type: "array", items: { type: "object", properties: { integration: { type: "string", enum: ["email", "granola"] }, account: { type: "string" } }, required: ["integration", "account"], additionalProperties: false } },
  }, required: ["label", "mode"], additionalProperties: false,
};
export function environmentProposal(value: unknown, path: string): { label: string; grant: ProjectGrant } {
  const { label, ...scope } = environmentProposalSchema.parse(value);
  return { label, grant: { ...scope, path } };
}
