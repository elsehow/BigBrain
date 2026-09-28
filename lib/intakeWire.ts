/** Compatibility spelling for HTTP clients predating native insertions.
 * Internal receipts always name real files. `ref_path` is the readable
 * path on this wire; `path` retains the old inbox label for older clients. */
import { basename } from "node:path";
import { slugify } from "./fsx";
import type { IntakeReceipt } from "./intake";

export function intakeWireReceipt(receipt: IntakeReceipt, name?: string) {
  const label = name ? slugify(basename(name).replace(/\.md$/i, "")) : receipt.insertionId;
  return { id: receipt.id, path: `inbox/${label}.md`, ref_path: receipt.path };
}
