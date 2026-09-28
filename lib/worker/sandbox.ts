/** Host-side channel to one sandbox manager per worker. No model credentials cross it. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { ENGINE_ROOT } from "../engine";
export interface WorkerScope { project: string; scratch: string; references: string[]; mode: "read" | "work"; domains: string[]; network?: "public" }
export interface CommandResult { stdout: string; stderr: string; exitCode: number | null }
export const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
function certificateEnvironment(): Record<string, string> {
  const bundle = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"].find(existsSync);
  if (!bundle) return {};
  // macOS /etc is a symlink: reading its target avoids granting all of /etc.
  const path = realpathSync(bundle);
  return Object.fromEntries(["SSL_CERT_FILE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"].map(name => [name, path]));
}
export function workerEnvironment(scratch: string): NodeJS.ProcessEnv {
  return { HOME: scratch, TMPDIR: scratch, PATH: [dirname(process.execPath), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"), LANG: "en_US.UTF-8", TERM: "dumb", ...certificateEnvironment() };
}
export class WorkerSandbox {
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private closed = false;
  private controlDirectory?: string;
  private pending = new Map<string, { resolve: (value: CommandResult) => void; reject: (error: Error) => void; cleanup: () => void; pid?: number }>();
  constructor(readonly scope: WorkerScope, private credentials: Record<string, string> = {}) {}
  start(): Promise<void> {
    return this.ready ??= new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("Worker executor is closed."));
      this.controlDirectory = realpathSync(mkdtempSync("/tmp/bbs-"));
      const child = this.child = spawn(process.execPath, [join(ENGINE_ROOT, "bin/workerSandbox.ts")], { cwd: ENGINE_ROOT, env: { ...workerEnvironment(this.scope.scratch), TMPDIR: this.controlDirectory }, stdio: "pipe", detached: true });
      const timer = setTimeout(() => { this.close(); reject(new Error("Worker sandbox startup timed out.")); }, 15_000);
      let started = false;
      const lines = createInterface({ input: child.stdout });
      lines.on("line", line => {
        try {
          const event = JSON.parse(line);
          if (event.ready) { started = true; clearTimeout(timer); resolve(); return; }
          if (event.startupError) { clearTimeout(timer); reject(new Error(event.startupError)); this.close(); return; }
          const task = this.pending.get(event.id); if (!task) return;
          if (event.pid) { task.pid = event.pid; return; }
          task.cleanup(); this.pending.delete(event.id);
          if (event.error) task.reject(new Error(event.error)); else task.resolve(event.result);
        } catch { this.close(); reject(new Error("Invalid worker sandbox response.")); }
      });
      // Never echo command payloads or credentials in process diagnostics.
      child.stderr.resume();
      const died = () => { clearTimeout(timer); if (!started) reject(new Error("Worker sandbox could not start. Execution is blocked.")); this.close(); };
      child.once("error", died); child.once("exit", () => { died(); if (this.controlDirectory) rmSync(this.controlDirectory, { recursive: true, force: true }); });
      child.stdin.write(JSON.stringify({ scope: this.scope, credentials: this.credentials }) + "\n");
    });
  }
  async run(command: string, signal: AbortSignal, input?: string, timeoutMs = 120_000): Promise<CommandResult> {
    signal.throwIfAborted(); await this.start(); signal.throwIfAborted();
    if (this.closed) throw new Error("Worker executor is closed.");
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      const abort = () => { this.child?.stdin.write(JSON.stringify({ cancel: id }) + "\n"); };
      const timer = setTimeout(abort, Math.min(600_000, Math.max(1000, timeoutMs)));
      this.pending.set(id, { resolve, reject, cleanup: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } });
      signal.addEventListener("abort", abort, { once: true });
      this.child!.stdin.write(JSON.stringify({ id, command, input }) + "\n");
      if (signal.aborted) abort();
    });
  }
  close(): void {
    if (this.closed) return; this.closed = true;
    for (const task of this.pending.values()) { if (task.pid) killGroup(task.pid); task.cleanup(); task.reject(new Error("Worker executor stopped.")); }
    this.pending.clear();
    this.child?.stdin.end();
    const child = this.child;
    if (child?.pid) { child.kill("SIGTERM"); const timer = setTimeout(() => { if (child.exitCode === null) killGroup(child.pid!); }, 1000); timer.unref(); }
  }
}
export function killGroup(pid: number): void { try { process.kill(-pid, "SIGKILL"); } catch { /* already stopped */ } }
/** System tools are readable; user directories require an explicit scope. */
export function systemReadPaths(): string[] {
  return ["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64", "/lib", "/lib64", "/usr/share", "/usr/libexec", "/bin", "/sbin", "/System/Library", "/Library/Developer/CommandLineTools", "/Library/Apple",
    ...["/opt/homebrew", "/usr/local"].flatMap(p => ["bin", "lib", "Cellar", "opt", "share"].map(d => join(p, d))),
    join(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime"))), "../vendor"),
    "/dev", "/etc/ssl", "/private/etc/ssl", ...Object.values(certificateEnvironment()), realpathSync(process.execPath)]
    .filter(existsSync).flatMap(p => [p, realpathSync(p)]);
}
