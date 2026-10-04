import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agents, Harbor, workspace, type OpenOptions } from "../packages/agents/src";
import { CodingDesktops } from "../lib/codingDesktops";
import { nativeVault } from "./support/vault";

const roots: string[] = [];
afterAll(() => roots.forEach(r => rmSync(r, { recursive: true, force: true })));

async function fakeHost(responses: unknown[]) {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider } = await import("@earendil-works/pi-ai");
  const faux = fauxProvider();
  const ws = mkdtempSync(join(tmpdir(), "coding-ws-"));
  roots.push(ws);
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false, authPath: join(ws, "auth.json") });
  modelRuntime.registerNativeProvider(faux.provider);
  await modelRuntime.setRuntimeApiKey(faux.provider.id, "invented");
  faux.setResponses(responses as never);
  const host = async (): Promise<OpenOptions> => ({ modelRuntime, model: faux.getModel() as never, instructions: "You are a test agent.", tools: [] });
  return { ws, host };
}

test("a coding desktop: its agent shows a local page, the transcript reads back, Quick names it, and the person's hand wins", async () => {
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
  const { ws, host } = await fakeHost([
    fauxAssistantMessage([fauxToolCall("show_page", { url: "https://example.invalid/" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("show_page", { url: "http://127.0.0.1:5173/", title: "Orrery preview" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("The orrery preview is beside this chat."),
  ]);
  const root = nativeVault(); roots.push(root);
  const named: string[] = [];
  const desktops = new CodingDesktops(root, { agents: new Agents(workspace(ws), new Harbor()), host,
    nameTask: async (_root, messages) => { named.push(messages[0]!.text); return "Orrery preview"; } });

  const made = desktops.create({ context: [{ path: "entities/orrery.md", title: "Orrery" }] });
  expect(desktops.list().map(d => [d.id, d.kind, d.title, d.phase])).toEqual([[made.id, "coding", "New desktop", "draft"]]);

  await desktops.send(made.id, "show me the orrery", "in-1");
  await desktops.send(made.id, "show me the orrery", "in-1"); // a retry does nothing
  for (let i = 0; i < 50 && desktops.list()[0]!.phase !== "answered"; i++) await Bun.sleep(20);

  const detail = await desktops.detail(made.id);
  expect(detail.messages.map(m => [m.role, m.text])).toEqual([
    ["user", "show me the orrery"],
    ["activity", "Showed https://example.invalid/ failed"],
    ["activity", "Showed http://127.0.0.1:5173/"],
    ["assistant", "The orrery preview is beside this chat."],
  ]);
  expect(detail.messages.filter(m => m.role === "activity").map(m => m.ok)).toEqual([false, true]);
  // only the loopback page made it onto the desktop
  expect(detail.desktop?.views.map(v => [v.kind, v.path, v.title])).toEqual([["url", "http://127.0.0.1:5173/", "Orrery preview"]]);
  expect(detail.contextNodes).toEqual([{ id: "entities/orrery.md", path: "entities/orrery.md", title: "Orrery" }]);

  for (let i = 0; i < 50 && desktops.get(made.id).title === "New desktop"; i++) await Bun.sleep(20);
  expect(desktops.get(made.id)).toMatchObject({ title: "Orrery preview", titleSource: "auto" });
  expect(named).toEqual(["show me the orrery"]);
  desktops.rename(made.id, "My orrery");
  expect(desktops.get(made.id)).toMatchObject({ title: "My orrery", titleSource: "human" });

  const view = detail.desktop!.views[0]!.id;
  expect(desktops.view(made.id, "close", { view }).desktop?.closed).toEqual(["http://127.0.0.1:5173/"]);

  // the live stream replays what came before
  const written: string[] = [];
  const res = { writeHead() { return this; }, write(s: string) { written.push(s); return true; }, end() {} } as unknown as ServerResponse;
  desktops.stream(made.id, 0, res, () => {});
  expect(written.filter(w => w.startsWith("data: ")).map(w => JSON.parse(w.slice(6)).type)).toContain("message.done");

  const archived = await desktops.archive(made.id);
  expect(archived.archivedAt).toBeTruthy();
  expect(desktops.list()[0]!.deactivatedAt).toBe(archived.archivedAt);
  desktops.close();
});

test("an agent's own page: plain HTML shown as a view, updated in place by title, and bounded", async () => {
  const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
  const { ws, host } = await fakeHost([
    fauxAssistantMessage([fauxToolCall("show_html", { title: "Gear report", html: "<h1>Gears</h1><p>Four.</p>" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("show_html", { title: "Gear report", html: "<h1>Gears</h1><p>Five.</p>" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("show_html", { title: "Huge", html: "x".repeat(200_001) })], { stopReason: "toolUse" }),
    fauxAssistantMessage("Done."),
  ]);
  const root = nativeVault(); roots.push(root);
  const desktops = new CodingDesktops(root, { agents: new Agents(workspace(ws), new Harbor()), host });
  const made = desktops.create();
  await desktops.send(made.id, "report on the gears", "in-1");
  for (let i = 0; i < 50 && desktops.list()[0]!.phase !== "answered"; i++) await Bun.sleep(20);
  const detail = await desktops.detail(made.id);
  expect(detail.desktop?.views.map(v => [v.kind, v.title, v.html])).toEqual([["html", "Gear report", "<h1>Gears</h1><p>Five.</p>"]]);
  expect(detail.messages.filter(m => m.role === "activity").map(m => [m.text, m.ok])).toEqual([
    ["Showed Gear report", true], ["Showed Gear report", true], ["Showed Huge failed", false]]);
  expect(desktops.writeTheme(":root{--bg:#fff}").path).toBe(join(ws, "bigbrain.css"));
  expect(() => desktops.writeTheme("")).toThrow();
  desktops.close();
});

test("only pages on this machine can be shown", async () => {
  const { loopbackUrl } = await import("../lib/pilotDesktop");
  expect(loopbackUrl("http://localhost:3000/app")).toBe("http://localhost:3000/app");
  for (const bad of ["https://127.0.0.1:5173/", "http://example.invalid/", "file:///etc/hosts", "not a url"])
    expect(() => loopbackUrl(bad)).toThrow();
});
