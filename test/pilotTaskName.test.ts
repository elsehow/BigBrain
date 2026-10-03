import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { cleanTaskName, namingMoment, taskNamePrompt, type TaskNamer } from "../lib/pilotTaskName";
import { PilotChats } from "./support/pilotSession";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
const vault = () => { const root = nativeVault({ files: { ".env": "OPENAI_API_KEY=sk-test-not-a-real-api-key\nBIGBRAIN_PILOT_ENABLED=true\n" } }); roots.push(root); return root; };
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));
const said = (role: "user" | "assistant", text: string) => ({ id: crypto.randomUUID(), role, text, at: new Date().toISOString() });
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("pilot task names", () => {
  test("Quick's reply is tidied into a name, or refused", () => {
    expect(cleanTaskName('"Orrery gear ratios."\n')).toBe("Orrery gear ratios");
    expect(cleanTaskName("Title: Atlas launch checklist")).toBe("Atlas launch checklist");
    expect(cleanTaskName("   \n  ")).toBeNull();
    expect(cleanTaskName("this is far too many words to be any kind of reasonable name for a task at all")).toBeNull();
  });

  test("names settle: the 1st, 2nd, 4th, 8th… user message", () => {
    expect([1, 2, 3, 4, 5, 8, 12, 16].map(namingMoment)).toEqual([true, true, false, true, false, true, false, true]);
    expect(namingMoment(0)).toBe(false);
  });

  test("the prompt carries how it began, where it is, and the name so far", () => {
    const p = taskNamePrompt([said("user", "help me plan the orrery repair"), said("assistant", "Sure."), said("user", "the brass gears")], "Orrery repair");
    expect(p).toContain("It began: help me plan the orrery repair");
    expect(p).toContain("Person: the brass gears");
    expect(p).toContain("Its name so far: Orrery repair");
    expect(taskNamePrompt([said("user", "hi")], "New session")).not.toContain("name so far");
  });

  test("Quick names an untitled session; a person's rename stands for good", async () => {
    const asked: string[] = [];
    const namer: TaskNamer = async (_root, messages) => { asked.push(messages.at(-1)!.text); return `Named after ${messages.filter((m) => m.role === "user").length}`; };
    const sessions = new PilotChats(vault(), { graph: () => [], nameTask: namer });
    const s = sessions.create([]);
    const retitle = (sessions as unknown as { retitle(x: typeof s): void }).retitle.bind(sessions);
    s.messages.push(said("user", "first"));
    retitle(s); retitle(s); await settle();
    expect(s.title).toBe("Named after 1");
    expect(asked).toHaveLength(1); // once per naming moment
    s.messages.push(said("assistant", "ok"), said("user", "second"));
    retitle(s); await settle();
    expect(s.title).toBe("Named after 2");
    sessions.rename(s.id, "Brass gear sourcing");
    expect(s.titleSource).toBe("human");
    s.messages.push(said("user", "third"), said("user", "fourth"));
    retitle(s); await settle();
    expect(s.title).toBe("Brass gear sourcing");
    expect(() => sessions.rename(s.id, " ")).toThrow("title");
  });

  test("without a namer the engine never asks Quick", async () => {
    const sessions = new PilotChats(vault(), { graph: () => [] });
    const s = sessions.create([]);
    s.messages.push(said("user", "first"));
    (sessions as unknown as { retitle(x: typeof s): void }).retitle(s);
    await settle();
    expect(s.title).toBe("New session");
  });
});
