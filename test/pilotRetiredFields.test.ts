import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PilotChats } from "../lib/pilotChat";
import { validateSavedPilot } from "../lib/pilotChatPersistence";
import { pilotChatDetail } from "../lib/pilotChatSummary";
import { writeAtomic } from "../lib/fsx";
import { spoolDir } from "../lib/spool";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const at = "2026-09-20T12:00:00.000Z", id = `pilot-${"d".repeat(32)}`;

// A conversation as the engine wrote it before Pilot notifications were removed:
// Pilot asked a question by notification, and a voice reply answered it while
// inputs still carried a worker target. Vaults are never migrated, so these
// bytes must keep loading; the schema's passthrough is what lets them.
const saved = {
  id, title: "Atlas dates", model: "gpt-5.6-terra", phase: "answered", lifecycle: "active", lastActivityAt: at,
  seed: [], context: [], viewRevision: 1, revision: 6, draft: "", live: "", activity: "", error: "", created: at, updated: at,
  backend: { adapter: "pi", provider: "openai", model: "gpt-5.6-terra", reasoning: "low" },
  messages: [
    { id: "m-ask", role: "user", text: "Plan the Atlas review", at },
    { id: "m-question", role: "assistant", text: "Thursday or Friday?", at },
    { id: "m-answer", role: "user", text: "Thursday", at },
    { id: "m-done", role: "assistant", text: "Thursday it is.", at },
  ],
  inputs: [
    { id: "input-ask-0001", message: "m-ask", mode: "text", text: "Plan the Atlas review" },
    { id: "input-answer-01", message: "m-answer", mode: "voice", text: "Thursday", notificationId: "n-date", target: `work-${"e".repeat(32)}` },
  ],
  notifications: [{ id: "n-date", pilotId: id, pilotTitle: "Atlas dates", messageId: "m-question", key: "date-choice",
    text: "Thursday or Friday?", kind: "question", at, seen: true, resolved: true }],
};

test("a conversation saved with notifications loads, is served without them, and saves them back untouched", () => {
  const root = nativeVault(); roots.push(root);
  const file = join(spoolDir(root), "pilot-chats", `${id}.json`);
  expect(validateSavedPilot(structuredClone(saved), file)).toMatchObject({ notifications: saved.notifications, inputs: saved.inputs });
  writeAtomic(file, JSON.stringify(saved));

  const chats = new PilotChats(root, { graph: () => [], categories: false });
  try {
    expect(chats.loadIssues).toEqual([]);
    const summary = chats.summaries().find(v => v.id === id)!;
    expect(summary).toBeDefined();
    expect(summary).not.toHaveProperty("notifications");
    const detail = pilotChatDetail(chats.get(id));
    expect(detail).not.toHaveProperty("notifications");
    expect(detail.inputs).toEqual([
      { id: "input-ask-0001", text: "Plan the Atlas review", mode: "text", message: "m-ask", images: undefined },
      { id: "input-answer-01", text: "Thursday", mode: "voice", message: "m-answer", images: undefined },
    ]);
    // The question the notification posted stays in the transcript as an ordinary message.
    expect(detail.messages.map(m => m.text)).toEqual(saved.messages.map(m => m.text));

    chats.rename(id, "Atlas review dates");
  } finally { chats.close(); }

  const written = JSON.parse(readFileSync(file, "utf8"));
  expect(written.title).toBe("Atlas review dates");
  expect(written.notifications).toEqual(saved.notifications);
  expect(written.inputs).toEqual(saved.inputs);

  const restarted = new PilotChats(root, { graph: () => [], categories: false });
  try { expect(restarted.loadIssues).toEqual([]); expect(restarted.get(id).messages).toHaveLength(4); }
  finally { restarted.close(); }
});
