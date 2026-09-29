/** Exact model selection never sends a server-side fallback list (#4). */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { stream as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Api, Model } from "@earendil-works/pi-ai";
import { PiSession, exactModel } from "../lib/run/piSession";
import { fakePi } from "./support/pi";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
// The bundled record that carries a fallback list (Pi 0.85.1: claude-fable-5).
const withFallback = () => builtinProviders().find(p => p.id === "anthropic")!.getModels()
  .find(m => (m.compat as { allowedFallbackModels?: unknown[] } | undefined)?.allowedFallbackModels?.length) as Model<Api>;

test("the real Anthropic adapter sends fallbacks for the bundled record, and none for the exact model", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    bodies.push(await request.json()); return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
  } });
  cleanups.push(() => server.stop(true));
  const bundled = { ...withFallback(), baseUrl: `http://127.0.0.1:${server.port}` } as Model<"anthropic-messages">;
  const context = { messages: [{ role: "user" as const, content: "Synthetic", timestamp: Date.now() }] };
  for (const model of [bundled, exactModel(bundled)]) await anthropicStream(model, context, { apiKey: "fabricated-key" }).result();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.fallbacks).toBeDefined();
  expect(bodies[1]!.fallbacks).toBeUndefined();
  expect(bodies[1]!.model).toBe(bundled.id);
});

test("PiSession strips the fallback list from every request and keeps the rest of the record", async () => {
  const root = mkdtempSync(join(tmpdir(), "exact-model-")); writeFileSync(join(root, "vault.yaml"), "integrations: {}\n");
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const selected = withFallback(), seen: Model<Api>[] = [];
  const scripted = fakePi(() => ({ result: "Synthetic answer." }));
  const load = async () => {
    const sdk = await scripted(), runtime = await sdk.ModelRuntime.create({} as never), original = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = ((model, context, options) => { seen.push(model); return original(model, context, options); }) as typeof runtime.streamSimple;
    return sdk;
  };
  const quota = { account: async () => "fixture-account", read: async () => [] };
  const session = new PiSession({ root, config: { adapter: "pi", provider: "anthropic", model: selected.id }, instructions: "Fixture", tools: [], state: { through: 0 }, save() {} },
    load, true, async () => [], quota as never);
  cleanups.push(() => session.close());
  expect(await session.turn({ signal: new AbortController().signal, input: () => "Synthetic", connected() {}, delta() {}, tool: async () => null })).toBe("Synthetic answer.");
  expect(seen.length).toBeGreaterThan(0);
  for (const model of seen) {
    expect(model.id).toBe(selected.id);
    expect((model.compat as Record<string, unknown>).allowedFallbackModels).toBeUndefined();
  }
  const { allowedFallbackModels: _dropped, ...rest } = selected.compat as Record<string, unknown>;
  expect(seen[0]!.compat).toEqual(rest);
});
