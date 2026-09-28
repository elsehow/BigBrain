/** Opt-in live benchmark of the production Pilot path, using synthetic scratch vaults.
 * bun test/support/profilePilotProviders.ts --live [pairs=3]
 * Prints timings only; never exports prompts, answers, or credentials. */
import { readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { nativeVault } from "./vault";
import { PilotChats } from "../../lib/pilotChat";
import { MODEL_DEFAULTS } from "../../lib/modelDefaults";
import type { PilotTiming } from "../../lib/pilotConversation";
if (process.argv[2] !== "--live") throw new Error("Pass --live to make synthetic subscription model requests.");
const pairs = Number(process.argv[3] ?? 3);
if (!Number.isInteger(pairs) || pairs < 1 || pairs > 5) throw new Error("Pairs must be 1–5.");
for (const config of [
  { adapter: "pi", provider: "openai-codex", ...MODEL_DEFAULTS.openai.pilot },
  { adapter: "claude", ...MODEL_DEFAULTS.anthropic.pilot },
]) {
  for (let pair = 0; pair < pairs; pair++) {
    const root = nativeVault({ files: { "memory/MEMORY.md": "# Synthetic fixture\nAtlas is a fictional tool library.\n" } });
    const chats = new PilotChats(root, { graph: () => [] });
    try {
      chats.setDefaultBackend(config);
      const session = chats.create([]);
      for (const mode of ["fresh", "reused"] as const) {
        const start = performance.now();
        chats.send(session.id, mode === "fresh" ? 'Synthetic latency check: reply with exactly "Atlas is ready." Use no tools.' : 'Reply with exactly "Still ready." Use no tools.');
        const timeout = setTimeout(() => chats.stop(session.id), 60_000);
        try { await chats.settled(session.id); } finally { clearTimeout(timeout); }
        const dir = join(root, ".spool", "pilot-timings", session.id);
        const rows = readdirSync(dir).map(f => JSON.parse(readFileSync(join(dir, f), "utf8")) as PilotTiming).sort((a,b) => a.startedAt.localeCompare(b.startedAt));
        const t = rows.at(-1)!;
        console.log(JSON.stringify({ provider: config.adapter, model: config.model, reasoning: "reasoning" in config ? config.reasoning : "default", pair, mode,
          status: t.status, setupMs: t.setupMs, firstTextMs: t.firstTextMs, totalMs: t.totalMs,
          afterDispatchMs: t.firstTextMs !== undefined && t.setupMs !== undefined ? t.firstTextMs - t.setupMs : undefined,
          tools: t.tools.length, callerMs: Math.round(performance.now() - start) }));
        if (session.phase !== "answered") throw new Error(session.error || session.phase);
      }
    } finally { chats.close(); rmSync(root, { recursive: true, force: true }); }
  }
}
