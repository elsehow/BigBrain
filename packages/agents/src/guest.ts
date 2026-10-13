/**
 * guest.ts — the host's side of the guest protocol (PROTOCOL.md).
 *
 * `Guest` is how the engine reaches a desktop's files and commands: in a
 * machine through its helper's guest.sock, or through `bigbrain-guest
 * --serve` on a Unix socket. Everything it receives is the guest's word and
 * is treated as hostile: a frame is bounded before it is buffered, an answer
 * is checked against a closed schema before it is used, and a guest's
 * message is cut and stripped of control characters before anyone sees it.
 * No answer carries a path the host resolves.
 */
import { createConnection, type Socket } from "node:net";
import { createHash } from "node:crypto";

export const PROTOCOL = 1;

export const KIND = { control: 0, stdout: 1, stderr: 2, stdin: 3, data: 4 } as const;
export const CONTROL_CAP = 256 * 1024;
export const DATA_CAP = 1024 * 1024;
export const LIMITS = {
  path: 4096, argv: 256, argvBytes: 1024 * 1024, env: 1024, envBytes: 128 * 1024, list: 10_000,
  read: 64 * 1024 * 1024, write: 256 * 1024 * 1024, connections: 64, jobs: 64,
} as const;
/** The first answer frame of any request arrives within this, or the request fails. */
export const ANSWER_MS = 30_000;

export const ERROR_CODES = ["bad-request", "not-found", "is-directory", "not-directory", "too-large", "conflict", "no-such-job", "limit", "internal"] as const;
/** What a request can fail with: the guest's codes, and the host's own when the guest broke the protocol or went away. */
export type GuestErrorCode = typeof ERROR_CODES[number] | "protocol" | "unreachable" | "timeout";

export class GuestError extends Error {
  constructor(readonly code: GuestErrorCode, message: string) { super(message); this.name = "GuestError"; }
}

/** A guest's string, fit to become a label, an event or a message: no control characters, at most `max` characters. */
export function clean(s: unknown, max = 300): string {
  const text = typeof s === "string" ? s : "";
  // controls, line separators, and the bidirectional overrides that make a name read as another
  const stripped = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ");
  return stripped.length > max ? stripped.slice(0, max - 1) + "\u2026" : stripped;
}

// ── frames ───────────────────────────────────────────────────────────────

export type Frame = { kind: 0; control: Record<string, unknown> } | { kind: 1 | 2 | 3 | 4; data: Buffer };

export function encode(kind: number, payload: Buffer | Uint8Array): Buffer {
  const head = Buffer.alloc(5);
  head[0] = kind;
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
}

export const control = (v: Record<string, unknown>): Buffer => encode(KIND.control, Buffer.from(JSON.stringify(v)));

/** Splits a byte stream into frames, refusing an unknown kind or an oversized
 * length from the header alone: nothing past a bad header is buffered. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private size = 0;
  /** Raw bytes after `connect`: frames stop. */
  raw = false;

  push(chunk: Buffer): void { this.chunks.push(chunk); this.size += chunk.length; }

  /** The next whole frame, undefined if more bytes are needed; throws on a bad frame. */
  next(): Frame | undefined {
    if (this.size < 5) return undefined;
    const head = this.peek(5);
    const kind = head[0]!, length = head.readUInt32BE(1);
    if (kind > 4) throw new GuestError("protocol", `the guest sent a frame of unknown kind ${kind}`);
    const cap = kind === KIND.control ? CONTROL_CAP : DATA_CAP;
    if (length > cap) throw new GuestError("protocol", `the guest sent a ${length}-byte frame, over the ${cap}-byte cap`);
    if (this.size < 5 + length) return undefined;
    const payload = this.take(5 + length).subarray(5);
    if (kind !== KIND.control) return { kind: kind as 1 | 2 | 3 | 4, data: payload };
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)); }
    catch { throw new GuestError("protocol", "the guest sent a control frame that is not UTF-8 JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new GuestError("protocol", "the guest sent a control frame that is not a JSON object");
    return { kind: 0, control: value as Record<string, unknown> };
  }

  /** What's buffered, as raw bytes (after `connect`). */
  drain(): Buffer { const all = Buffer.concat(this.chunks); this.chunks = []; this.size = 0; return all; }

  private peek(n: number): Buffer {
    if (this.chunks[0]!.length < n) this.chunks = [Buffer.concat(this.chunks)];
    return this.chunks[0]!.subarray(0, n);
  }
  private take(n: number): Buffer {
    if (this.chunks[0]!.length < n) this.chunks = [Buffer.concat(this.chunks)];
    const first = this.chunks[0]!;
    const out = first.subarray(0, n);
    if (first.length === n) this.chunks.shift(); else this.chunks[0] = first.subarray(n);
    this.size -= n;
    return out;
  }
}

// ── answers: closed schemas ───────────────────────────────────────────────

type Check = (v: unknown) => boolean;
const int: Check = v => Number.isSafeInteger(v) && (v as number) >= 0;
const str: Check = v => typeof v === "string";
const bool: Check = v => typeof v === "boolean";
const nul = (c: Check): Check => v => v === null || c(v);
const arr = (c: Check, max = Infinity): Check => v => Array.isArray(v) && v.length <= max && v.every(c);
const sha: Check = v => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const oneOf = (...xs: string[]): Check => v => typeof v === "string" && xs.includes(v);
/** An object with exactly these keys (`?` marks optional ones), each passing its check. */
const obj = (shape: Record<string, Check>): Check => v => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!(k in shape) && !(`${k}?` in shape)) return false;
  for (const [key, check] of Object.entries(shape)) {
    const optional = key.endsWith("?"), k = optional ? key.slice(0, -1) : key;
    if (!(k in o)) { if (optional) continue; return false; }
    if (!check(o[k])) return false;
  }
  return true;
};

const ok = { ok: (v: unknown) => v === true };
const KINDS = ["file", "dir", "link", "other"] as const;
export type EntryKind = typeof KINDS[number];
const exit = obj({ code: nul(int), signal: nul(str) });

const ANSWERS = {
  hello: obj({ ...ok, protocol: int, agent: str, image: str, arch: str, booted: int }),
  exec: obj({ ...ok, job: int, pid: int }),
  exit: obj({ event: (v: unknown) => v === "exit", "code": nul(v => Number.isSafeInteger(v)), signal: nul(str) }),
  empty: obj(ok),
  "job.list": obj({ ...ok, jobs: arr(obj({ job: int, argv: arr(str), started: int, exited: nul(exit), ports: arr(int) })) }),
  "job.output": obj({ ...ok, from: int, to: int }),
  ports: obj({ ...ok, ports: arr(obj({ port: int, pid: int, job: nul(int) })) }),
  stat: obj({ ...ok, kind: oneOf(...KINDS), size: int, mtime: int, mode: int, "sha256?": sha }),
  list: obj({ ...ok, entries: arr(obj({ name: str, kind: oneOf(...KINDS) }), LIMITS.list), "truncated?": bool }),
  read: obj({ ...ok, size: int, length: int, "sha256?": sha }),
  write: obj({ ...ok, sha256: sha }),
  error: obj({ ok: (v: unknown) => v === false, error: oneOf(...ERROR_CODES), message: str }),
};

function expect<T>(schema: keyof typeof ANSWERS, v: Record<string, unknown>, op: string): T {
  if (v.ok === false) {
    if (!ANSWERS.error(v)) throw new GuestError("protocol", `the guest's refusal of ${op} is malformed`);
    throw new GuestError(v.error as GuestErrorCode, clean(v.message));
  }
  if (!ANSWERS[schema](v)) throw new GuestError("protocol", `the guest's answer to ${op} doesn't fit the protocol`);
  return v as T;
}

// ── connections ───────────────────────────────────────────────────────────

/** One connection, one request: frames in order, with backpressure on writes. */
class Conn {
  private reader = new FrameReader();
  private waiting: Array<{ resolve: (f: Frame | null) => void; reject: (e: Error) => void }> = [];
  private ready: Frame[] = [];
  private failed?: Error;
  private ended = false;

  constructor(readonly socket: Socket, private answerMs: number) {
    socket.on("data", (chunk: Buffer) => {
      if (this.reader.raw) return;
      this.reader.push(chunk);
      this.pump();
    });
    socket.on("error", e => this.fail(new GuestError("unreachable", clean(e.message))));
    socket.on("close", () => { this.ended = true; this.flush(); });
  }

  private pump(): void {
    try {
      for (let f = this.reader.next(); f; f = this.reader.next()) {
        this.ready.push(f);
        // after connect's answer the bytes are raw: stop framing at once
        if (f.kind === KIND.control && this.rawAfter?.(f)) {
          this.reader.raw = true;
          this.socket.pause();
          const rest = this.reader.drain();
          if (rest.length) this.socket.unshift(rest);
          this.flush();
          return;
        }
      }
    } catch (e) { this.fail(e as Error); this.socket.destroy(); return; }
    this.flush();
  }
  rawAfter?: (f: Frame) => boolean;

  private fail(e: Error): void { this.failed ??= e; this.flush(); }

  private flush(): void {
    while (this.waiting.length && this.ready.length) this.waiting.shift()!.resolve(this.ready.shift()!);
    if (this.failed) for (const w of this.waiting.splice(0)) w.reject(this.failed);
    else if (this.ended) for (const w of this.waiting.splice(0)) w.resolve(null);
  }

  /** The next frame, or null once the guest has closed the connection. */
  next(timeoutMs?: number): Promise<Frame | null> {
    if (this.ready.length) return Promise.resolve(this.ready.shift()!);
    if (this.failed) return Promise.reject(this.failed);
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      this.waiting.push(entry);
      if (timeoutMs) {
        const t = setTimeout(() => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) { this.waiting.splice(i, 1); reject(new GuestError("timeout", `the guest did not answer within ${timeoutMs / 1000} s`)); this.socket.destroy(); }
        }, timeoutMs);
        const settle = <A>(f: (a: A) => void) => (a: A) => { clearTimeout(t); f(a); };
        entry.resolve = settle(resolve); entry.reject = settle(reject);
      }
    });
  }

  /** The first answer: a control frame, within ANSWER_MS. */
  async answer(op: string, timeoutMs?: number): Promise<Record<string, unknown>> {
    const f = await this.next(timeoutMs ?? this.answerMs);
    if (!f) throw new GuestError("unreachable", `the guest closed the connection before answering ${op}`);
    if (f.kind !== KIND.control) throw new GuestError("protocol", `the guest answered ${op} with a data frame`);
    return f.control;
  }

  /** Data frames totalling exactly `length` bytes. */
  async data(length: number, op: string): Promise<Buffer> {
    const parts: Buffer[] = [];
    let got = 0;
    while (got < length) {
      const f = await this.next(this.answerMs);
      if (!f) throw new GuestError("unreachable", `the guest closed the connection mid-${op}`);
      if (f.kind !== KIND.data) throw new GuestError("protocol", `the guest sent a stray frame in ${op}`);
      if (got + f.data.length > length) throw new GuestError("protocol", `the guest sent more than it said in ${op}`);
      parts.push(f.data); got += f.data.length;
    }
    return Buffer.concat(parts);
  }

  write(b: Buffer): Promise<void> {
    if (this.socket.destroyed) return Promise.reject(new GuestError("unreachable", "the connection to the guest closed"));
    return new Promise((resolve, reject) => {
      const flushed = this.socket.write(b, e => e ? reject(new GuestError("unreachable", clean(e.message))) : undefined);
      if (flushed) resolve(); else this.socket.once("drain", () => resolve());
    });
  }

  close(): void { this.socket.destroy(); }
}

// ── the client ────────────────────────────────────────────────────────────

export interface Hello { protocol: number; agent: string; image: string; arch: string; booted: number }
export interface Stat { kind: EntryKind; size: number; mtime: number; mode: number; sha256?: string }
export interface Entry { name: string; kind: EntryKind }
export interface GuestJob { job: number; argv: string[]; started: number; exited: { code: number | null; signal: string | null } | null; ports: number[] }
export interface GuestPort { port: number; pid: number; job: number | null }
export interface ExecOptions { cwd: string; env?: Record<string, string>; user?: "work" | "root"; stdin?: boolean; grace?: number }
export interface Exited { code: number | null; signal: string | null }

/** A running `exec`: its output as it comes, its exit, and a way to end it. */
export interface Execution {
  job: number; pid: number;
  /** Resolves with the exit; rejects if the connection is lost first. */
  exit: Promise<Exited>;
  /** Write to its stdin (exec with `stdin`); an empty buffer closes it. */
  write(b: Buffer | string): Promise<void>;
  /** Close the connection: the guest stops the job unless it was detached. */
  close(): void;
}

/** How a Guest reaches its guest: a Unix socket path (guest.sock, or a --serve socket). */
export type Dial = () => Socket;

const checkPath = (p: string): string => {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0") || Buffer.byteLength(p) > LIMITS.path)
    throw new GuestError("bad-request", "a guest path is absolute, without NUL, at most 4,096 bytes");
  return p;
};

/** The guest protocol's client. Every method opens its own connection. */
export class Guest {
  private dial: Dial;
  constructor(socketPath: string | Dial, private options: { tz?: string; now?: () => number; answerMs?: number } = {}) {
    this.dial = typeof socketPath === "string" ? () => createConnection({ path: socketPath }) : socketPath;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async open(request: Record<string, unknown>): Promise<Conn> {
    const socket = this.dial();
    const conn = new Conn(socket, this.options.answerMs ?? ANSWER_MS);
    await new Promise<void>((resolve, reject) => {
      if (!socket.connecting) { resolve(); return; }
      socket.once("connect", () => resolve());
      socket.once("error", e => reject(new GuestError("unreachable", clean(e.message))));
    });
    const frame = control({ ...request, now: this.now() });
    if (frame.length - 5 > CONTROL_CAP) { conn.close(); throw new GuestError("bad-request", "the request is over the control frame cap"); }
    await conn.write(frame);
    return conn;
  }

  private async simple<T>(op: string, fields: Record<string, unknown>, schema: keyof typeof ANSWERS, timeoutMs?: number): Promise<T> {
    const conn = await this.open({ op, ...fields });
    try { return expect<T>(schema, await conn.answer(op, timeoutMs), op); }
    finally { conn.close(); }
  }

  hello(timeoutMs?: number): Promise<Hello> {
    const tz = this.options.tz ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "";
    return this.simple("hello", { protocol: PROTOCOL, tz }, "hello", timeoutMs);
  }

  async exec(argv: string[], o: ExecOptions, sink: (kind: "stdout" | "stderr", data: Buffer) => void): Promise<Execution> {
    if (!argv.length || argv.length > LIMITS.argv || argv.reduce((n, a) => n + Buffer.byteLength(a) + 1, 0) > LIMITS.argvBytes)
      throw new GuestError("bad-request", `argv has 1 to ${LIMITS.argv} entries, 1 MiB in all`);
    const env = o.env ?? {};
    if (Object.keys(env).length > LIMITS.env || Object.entries(env).reduce((n, [k, v]) => n + Buffer.byteLength(k) + Buffer.byteLength(v) + 2, 0) > LIMITS.envBytes)
      throw new GuestError("bad-request", `env has at most ${LIMITS.env} entries and 128 KiB`);
    const conn = await this.open({ op: "exec", argv, cwd: checkPath(o.cwd), env, user: o.user ?? "work", stdin: o.stdin ?? false, ...(o.grace !== undefined ? { grace: o.grace } : {}) });
    let started: { job: number; pid: number };
    try { started = expect("exec", await conn.answer("exec"), "exec"); }
    catch (e) { conn.close(); throw e; }
    const exit = (async (): Promise<Exited> => {
      for (;;) {
        const f = await conn.next();
        if (!f) throw new GuestError("unreachable", `the guest's connection for job ${started.job} closed before it exited`);
        if (f.kind === KIND.stdout || f.kind === KIND.stderr) { sink(f.kind === KIND.stdout ? "stdout" : "stderr", f.data); continue; }
        if (f.kind === KIND.control) {
          const e = expect<{ code: number | null; signal: string | null }>("exit", f.control, "exec");
          conn.close();
          return { code: e.code, signal: e.signal === null ? null : clean(e.signal, 16) };
        }
        throw new GuestError("protocol", "the guest sent a stray frame in exec");
      }
    })();
    exit.catch(() => conn.close());
    return {
      job: started.job, pid: started.pid, exit,
      write: async b => {
        const buf = typeof b === "string" ? Buffer.from(b) : b;
        if (!buf.length) return conn.write(encode(KIND.stdin, buf));
        for (let i = 0; i < buf.length; i += DATA_CAP) await conn.write(encode(KIND.stdin, buf.subarray(i, i + DATA_CAP)));
      },
      close: () => conn.close(),
    };
  }

  detach(job: number): Promise<void> { return this.simple("detach", { job }, "empty"); }
  /** Stop a job's process group: TERM, then KILL after `grace` ms. */
  stopJob(job: number, grace = 3000): Promise<void> { return this.simple("job.stop", { job, grace }, "empty", (this.options.answerMs ?? ANSWER_MS) + grace); }
  async jobs(): Promise<GuestJob[]> {
    const a = await this.simple<{ jobs: GuestJob[] }>("job.list", {}, "job.list");
    return a.jobs.map(j => ({ ...j, exited: j.exited && { code: j.exited.code, signal: j.exited.signal === null ? null : clean(j.exited.signal, 16) } }));
  }

  async jobOutput(job: number, since = 0): Promise<{ from: number; to: number; data: Buffer }> {
    const conn = await this.open({ op: "job.output", job, since });
    try {
      const a = expect<{ from: number; to: number }>("job.output", await conn.answer("job.output"), "job.output");
      if (a.to < a.from || a.to - a.from > 256 * 1024) throw new GuestError("protocol", "the guest's job.output range doesn't fit the protocol");
      return { ...a, data: await conn.data(a.to - a.from, "job.output") };
    } finally { conn.close(); }
  }

  async ports(): Promise<GuestPort[]> {
    return (await this.simple<{ ports: GuestPort[] }>("ports", {}, "ports")).ports.filter(p => p.port > 0 && p.port < 65536);
  }

  /** A raw byte pipe to 127.0.0.1:`port` in the guest: the socket, paused, once the guest has said yes. Pipe or resume it. */
  async connect(port: number): Promise<Socket> {
    const socket = this.dial();
    const conn = new Conn(socket, this.options.answerMs ?? ANSWER_MS);
    conn.rawAfter = f => f.kind === KIND.control && f.control.ok === true;
    await new Promise<void>((resolve, reject) => {
      if (!socket.connecting) { resolve(); return; }
      socket.once("connect", () => resolve());
      socket.once("error", e => reject(new GuestError("unreachable", clean(e.message))));
    });
    await conn.write(control({ op: "connect", port, now: this.now() }));
    try { expect("empty", await conn.answer("connect"), "connect"); }
    catch (e) { conn.close(); throw e; }
    socket.removeAllListeners("data");
    return socket;
  }

  async stat(path: string, hash = false): Promise<Stat> {
    const { ok: _, ...s } = await this.simple<Stat & { ok: true }>("stat", { path: checkPath(path), hash }, "stat");
    return s;
  }

  async list(path: string): Promise<{ entries: Entry[]; truncated: boolean }> {
    const a = await this.simple<{ entries: Entry[]; truncated?: boolean }>("list", { path: checkPath(path) }, "list");
    return { entries: a.entries, truncated: a.truncated ?? false };
  }

  /** A file's bytes (by default all of it, up to 64 MiB) and the whole file's size and sha256. */
  async read(path: string, o: { offset?: number; length?: number } = {}): Promise<{ data: Buffer; size: number; sha256?: string }> {
    const conn = await this.open({ op: "read", path: checkPath(path), offset: o.offset ?? 0, length: o.length ?? LIMITS.read });
    try {
      const a = expect<{ size: number; length: number; sha256?: string }>("read", await conn.answer("read"), "read");
      if (a.length > (o.length ?? LIMITS.read) || a.length > a.size) throw new GuestError("protocol", "the guest offered more than was asked");
      const data = await conn.data(a.length, "read");
      if (a.sha256 && (o.offset ?? 0) === 0 && a.length === a.size && createHash("sha256").update(data).digest("hex") !== a.sha256)
        throw new GuestError("protocol", "the guest's read doesn't match its own hash");
      return { data, size: a.size, ...(a.sha256 ? { sha256: a.sha256 } : {}) };
    } finally { conn.close(); }
  }

  /** Write a whole file. `ifMatch`: the sha256 it must still have, or null for "must not exist". */
  async write(path: string, data: Buffer | string, o: { mode?: number; ifMatch?: string | null; parents?: boolean } = {}): Promise<{ sha256: string }> {
    const body = typeof data === "string" ? Buffer.from(data) : data;
    if (body.length > LIMITS.write) throw new GuestError("too-large", "writes are at most 256 MiB");
    const conn = await this.open({ op: "write", path: checkPath(path), size: body.length, parents: o.parents ?? false,
      ...(o.mode !== undefined ? { mode: o.mode } : {}), ...(o.ifMatch !== undefined ? { ifMatch: o.ifMatch } : {}) });
    try {
      const answer = conn.answer("write", (this.options.answerMs ?? ANSWER_MS) + body.length / 1e5);
      // the guest may refuse before it has read everything: its answer wins over a broken pipe
      const sent = (async () => { for (let i = 0; i < body.length; i += DATA_CAP) await conn.write(encode(KIND.data, body.subarray(i, i + DATA_CAP))); })();
      sent.catch(() => undefined);
      const a = expect<{ sha256: string }>("write", await answer, "write");
      const mine = createHash("sha256").update(body).digest("hex");
      if (a.sha256 !== mine) throw new GuestError("protocol", "the guest wrote something other than what was sent");
      return { sha256: a.sha256 };
    } finally { conn.close(); }
  }

  /** Stop every job and power the machine off (a --serve guest exits). */
  shutdown(): Promise<void> { return this.simple("shutdown", {}, "empty"); }
}
