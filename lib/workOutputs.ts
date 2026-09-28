import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./fsx";
import { sha256hex } from "./hash";
import { spoolDir } from "./spool";

export interface WorkOutput { id: string; path: string; title: string; at: string; kind: "vault"; status: "submitted" }
const directory = (root: string, work: string) => {
  if (!/^work-[a-f0-9]{32}$/.test(work)) throw new Error("Invalid output owner");
  return join(spoolDir(root), "work-outputs", work);
};
/** Receipts are written by the app's MCP server, never inferred from prose. */
export function recordWorkOutput(root: string, work: string, receipt: { id: string; path: string }, title: string): void {
  if (!/^log\/insertions\/\d{4}-\d{2}\/ins_[a-f0-9]+\.json$/.test(receipt.path) || !existsSync(join(root, receipt.path))) throw new Error("Output receipt does not identify a saved source");
  if (existsSync(join(directory(root, work), `${sha256hex(receipt.path)}.json`))) return;
  const output: WorkOutput = { ...receipt, title: title.slice(0, 200), at: new Date().toISOString(), kind: "vault", status: "submitted" };
  writeAtomic(join(directory(root, work), `${sha256hex(receipt.path)}.json`), JSON.stringify(output), 0o600);
}
export function readWorkOutputs(root: string, work: string): WorkOutput[] {
  const dir = directory(root, work);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^[a-f0-9]{64}\.json$/.test(f)).flatMap(f => {
    try { return [JSON.parse(readFileSync(join(dir, f), "utf8")) as WorkOutput]; } catch { return []; }
  }).sort((a, b) => a.at.localeCompare(b.at));
}
