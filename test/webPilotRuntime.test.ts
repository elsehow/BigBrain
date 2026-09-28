import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { nativeVault } from "./support/vault";

test("development web entrypoint mounts the shared Pilot and notification runtime", async () => {
  const root = nativeVault();
  const reserve = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reserve.port!; reserve.stop(true);
  const child = Bun.spawn([process.execPath, "web/server.ts"], {
    env: { ...process.env, BIGBRAIN_DEV: "1", BIGBRAIN_VAULT: root, BIGBRAIN_WEB_PORT: String(port), BIGBRAIN_SUPERVISOR_PID: "" },
    stdout: "ignore", stderr: "ignore",
  });
  try {
    const base = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/api/pilot/chat/notifications`)).ok) { ready = true; break; } } catch { /* server starting */ }
      await Bun.sleep(25);
    }
    expect(ready).toBe(true);
    expect(await (await fetch(`${base}/api/pilot/chat/notifications`)).json()).toEqual({ notifications: [] });
    expect(await (await fetch(`${base}/api/pilot/chat`)).json()).toEqual({ sessions: [], issues: [] });
    expect((await fetch(`${base}/api/pilot/work`)).status).toBe(200);
  } finally { child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
}, 10_000);
