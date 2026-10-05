import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tickIntegrationAdmission } from "../lib/integrationAdmission";
import { accountFingerprint, accountPolicy, writeAccountPolicy } from "../lib/integrationAccess";
import { readSourceInsertionLog } from "../lib/insertionLog";
import { stage, stagedItems } from "../lib/stageStorage";
import { gitVault } from "./support/vault";

// All content here is invented.
const withStore = async (root: string, run: (store: string) => Promise<void>) => {
  const store = join(root, "connections.json"), before = process.env["BIGBRAIN_SHARED_CONNECTIONS"];
  process.env["BIGBRAIN_SHARED_CONNECTIONS"] = store;
  try { await run(store); } finally {
    if (before === undefined) delete process.env["BIGBRAIN_SHARED_CONNECTIONS"]; else process.env["BIGBRAIN_SHARED_CONNECTIONS"] = before;
    rmSync(root, { recursive: true, force: true });
  }
};

test("an account that remembers admits what it staged; one that doesn't keeps it pending", async () => {
  const account = "example@example.test";
  const root = gitVault({ files: { "vault.yaml": `integrations:\n  email:\n    inboxes:\n      - address: ${account}\n        host: imap.example.test\n`, ".env": "BIGBRAIN_IMAP_PASSWORD__EXAMPLE_EXAMPLE_TEST=fictional\n" } });
  await withStore(root, async (store) => {
    const remember = (enabled: boolean) => writeAccountPolicy(root, "email", account, { ...accountPolicy(root, "email", account), connected: true,
      fingerprint: accountFingerprint(root, "email", account), remembering: { enabled } });
    const item = (id: string) => ({ id, source: "email", account, at: "2026-09-01T00:00:00.000Z", line: id, name: `${id}.md`,
      content: `---\nid: ${id}\ntitle: Invented ${id}\nsource: email\nkind: email\ninbox: ${account}\n---\nAn invented message ${id}.` });
    remember(true);
    stage(root, item("fixture-one"));
    await tickIntegrationAdmission(root, store);
    expect(stagedItems(root, "email")).toHaveLength(0);
    expect(readSourceInsertionLog(root).map((s) => s.title)).toEqual(["Invented fixture-one"]);
    remember(false);
    stage(root, item("fixture-two"));
    await tickIntegrationAdmission(root, store);
    expect(stagedItems(root, "email").map((s) => s.id)).toEqual(["fixture-two"]);
  });
});

test("Granola lands verbatim transcripts and leaves older summary-only items pending", async () => {
  const { fakeIntegrationActivation } = await import("./support/integrationActivation");
  const root = gitVault({ files: { "vault.yaml": "integrations: {}\n" } });
  await withStore(root, async (store) => {
    fakeIntegrationActivation(root, "granola");
    writeAccountPolicy(root, "granola", "granola", { ...accountPolicy(root, "granola", "granola"), remembering: { enabled: true } });
    for (let i = 0; i < 3; i++) stage(root, { id: `legacy-${i}`, source: "granola", account: "granola", at: "2026-09-01", line: "Old note", name: "old.md",
      content: `---\nid: old-${i}\nsource: granola\nkind: meeting\n---\nVendor summary` });
    stage(root, { id: "raw-new", source: "granola", account: "granola", at: "2026-09-29", line: "Raw meeting", name: "raw.md",
      content: "---\nid: raw-new\nformat: granola-transcript-v1\nsource: granola\nkind: meeting\n---\nAttendees: Ada\n\nSpeaker: Exact words." });
    await tickIntegrationAdmission(root, store);
    expect(readSourceInsertionLog(root).map((s) => s.body)).toEqual([expect.stringContaining("Speaker: Exact words.")]);
    expect(stagedItems(root, "granola")).toHaveLength(3);
  });
});
