import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { nativeVault } from "./support/vault";
import { viewerFetch, viewerHome } from "./support/viewerSession";

test("development web entrypoint mounts the shared Pilot and notification runtime", async () => {
  const root = nativeVault(), home = viewerHome();
  const reserve = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reserve.port!; reserve.stop(true);
  const child = Bun.spawn([process.execPath, "web/server.ts"], {
    env: { ...process.env, HOME: home, BIGBRAIN_DEV: "1", BIGBRAIN_VAULT: root, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_SUPERVISOR_PID: "" },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    const get = (path: string): Promise<Response> => viewerFetch(home, port, path);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await get("/api/pilot/chat/notifications")).ok) { ready = true; break; } } catch { /* server starting */ }
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    expect(await (await get("/api/pilot/chat/notifications")).json()).toEqual({ notifications: [] });
    expect(await (await get("/api/pilot/chat")).json()).toEqual({ sessions: [], issues: [] });
    expect((await get("/api/pilot/work")).status).toBe(200);
  } finally { child.kill(); await child.exited; for (const d of [root, home]) rmSync(d, { recursive: true, force: true }); }
}, 10_000);
