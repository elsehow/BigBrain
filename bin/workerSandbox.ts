/** One manager process per worker: sandbox-runtime has process-global policy. */
import { isIP } from "node:net";
import { protectedProjectPaths } from "../lib/worker/protectedPaths";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { rgPath } from "@vscode/ripgrep";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { killGroup, shellQuote, systemReadPaths, workerEnvironment, type WorkerScope } from "../lib/worker/sandbox";
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const children = new Map<string, number>();
const cancelled = new Set<string>();
let credentials: Record<string, string> = {};
let scope: WorkerScope | undefined, initialization: Promise<void> | undefined, closed = false;
async function close() {
  if (closed) return; closed = true;
  for (const pid of children.values()) killGroup(pid);
  await SandboxManager.reset(); process.exit(0);
}
process.on("SIGTERM", () => { void close(); });
const lines = createInterface({ input: process.stdin });
lines.on("close", () => { void close(); });
lines.on("line", line => {
  void (async () => {
    const message = JSON.parse(line);
    if (message.scope && !scope) {
      scope = message.scope; credentials = message.credentials ?? {};
      initialization = initialize(scope!); await initialization; send({ ready: true }); return;
    }
    if (message.cancel) { cancelled.add(message.cancel); const pid = children.get(message.cancel); if (pid) killGroup(pid); return; }
    await initialization;
    if (!scope || closed || typeof message.id !== "string" || typeof message.command !== "string") throw new Error("Worker executor is not ready.");
    const command = `export HOME=${shellQuote(scope.scratch)} TMPDIR=${shellQuote(scope.scratch)}; ${message.command}`;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(command, "/bin/bash", undefined, undefined, scope.project);
    if (closed) return;
    if (cancelled.delete(message.id)) { send({ id: message.id, error: "Command cancelled." }); return; }
    const child = spawn(wrapped.argv[0]!, wrapped.argv.slice(1), { cwd: scope.project, env: { ...workerEnvironment(scope.scratch), ...credentials, ...wrapped.env }, detached: true, stdio: "pipe" });
    if (child.pid) { children.set(message.id, child.pid); send({ id: message.id, pid: child.pid }); }
    let stdout = "", stderr = "", bytes = 0;
    const collect = (value: Buffer, error: boolean) => {
      bytes += value.length;
      if (bytes > 2_000_000) { if (child.pid) killGroup(child.pid); return; }
      if (error) stderr += value.toString(); else stdout += value.toString();
    };
    child.stdout.on("data", v => collect(v, false)); child.stderr.on("data", v => collect(v, true));
    child.stdin.on("error", () => {}); child.stdin.end(message.input ?? "");
    child.once("error", () => { children.delete(message.id); send({ id: message.id, error: "Sandboxed command failed to start." }); });
    child.once("close", exitCode => { if (!children.delete(message.id)) return; cancelled.delete(message.id); send(bytes > 2_000_000 ? { id: message.id, error: "Command output exceeded 2 MB." } : { id: message.id, result: { stdout, stderr, exitCode } }); });
  })().catch(error => send({ startupError: error instanceof Error ? error.message : "Sandbox startup failed." }));
});
async function initialize(scope: WorkerScope) {
  if (!['darwin', 'linux'].includes(process.platform) || !SandboxManager.isSupportedPlatform()) throw new Error("Project execution requires the macOS or Linux sandbox. No unsandboxed fallback is available.");
  const deps = await SandboxManager.checkDependenciesAsync({ command: rgPath });
  if (deps.errors.length) throw new Error(`Worker sandbox dependencies unavailable: ${deps.errors.join("; ")}`);
  const protectedPaths = protectedProjectPaths([scope.project, ...scope.references]);
  await SandboxManager.initialize({
    filesystem: { denyRead: ["/", ...protectedPaths, "/**/.env", "/**/.env.*", "/**/.ssh", "/**/.aws", "/**/.claude", "/**/.codex", "/**/.pi", "/**/.git/hooks", "/**/auth.json"],
      allowRead: [...systemReadPaths(), rgPath, scope.project, scope.scratch, ...scope.references],
      allowWrite: [scope.scratch, ...(scope.mode === "work" ? [scope.project] : [])],
      denyWrite: [...protectedPaths, "/tmp/claude", "/private/tmp/claude", ...scope.references, `${scope.project}/.git/config`, `${scope.project}/.git/hooks`] },
    network: { allowedDomains: scope.domains, deniedDomains: [], strictAllowlist: scope.network !== "public", deniedResolvedAddresses: ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "::1/128", "fe80::/10", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"], allowLocalBinding: false, allowUnixSockets: [], allowAllUnixSockets: false },
    ripgrep: { command: rgPath }, allowPty: false,
  }, scope.network === "public" ? async ({ host }) => !isIP(host.replace(/^\[|\]$/g, "")) && !/^(?:localhost)$|\.(?:localhost|local|internal)$/i.test(host) : undefined, false);
  if (!SandboxManager.isSandboxingEnabled()) throw new Error("Worker sandbox failed to enforce policy.");
}
