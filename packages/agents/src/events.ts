/**
 * events.ts — one ordered, durable event stream per desktop.
 *
 * Appended as JSON lines under the desktop's state folder, each with a
 * sequence number, so a client that reloads replays what it missed with
 * `since(seq)`. Live listeners get each event as it is appended.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AgentEvent =
  | { type: "status"; status: "idle" | "working" | "waiting" | "failed" | "stopped" | "archived" }
  | { type: "input"; inputId: string; text: string; mode: "prompt" | "queued" | "steer" }
  | { type: "message.delta"; text: string }
  | { type: "message.done"; text: string }
  | { type: "tool.start"; call: string; tool: string; label: string }
  | { type: "tool.end"; call: string; tool: string; label: string; ok: boolean }
  | { type: "work.started"; project: string; branch: string; path: string; ms: number; cloned: string[] }
  | { type: "work.discarded"; project: string }
  | { type: "project.landed"; project: string; how: "pr" | "branch"; branch: string; url?: string }
  | { type: "server.started"; port: number; job: number; command: string; hostPort?: number }
  | { type: "server.exited"; job: number; code: number | null }
  | { type: "project.opened"; project: string; base: string; branch: string; ms: number; bytes: number }
  | { type: "project.synced"; project: string; from: string; to: string }
  | { type: "project.discarded"; project: string }
  | { type: "machine.preparing"; got: number; total: number }
  | { type: "machine.started"; ms: number; image: string }
  | { type: "machine.stopped"; why: string }
  | { type: "machine.failed"; message: string; console: string }
  | { type: "error"; message: string; recoverable: boolean };

export type Stamped = AgentEvent & { seq: number; at: string };

export class EventLog {
  private file: string;
  private seq = 0;
  private listeners = new Set<(e: Stamped) => void>();
  constructor(folder: string) {
    this.file = join(folder, "events.jsonl");
    if (existsSync(this.file)) {
      const lines = readFileSync(this.file, "utf8").trimEnd().split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) this.seq = (JSON.parse(last) as Stamped).seq;
    }
  }
  append(event: AgentEvent): Stamped {
    // Deltas and download progress are for live viewers only: the finished
    // message (or machine.started) is the durable record, so a live event
    // carries the last durable seq and is never written.
    const live = event.type === "message.delta" || event.type === "machine.preparing";
    const stamped = { ...event, seq: live ? this.seq : ++this.seq, at: new Date().toISOString() } as Stamped;
    if (!live) appendFileSync(this.file, JSON.stringify(stamped) + "\n");
    for (const l of this.listeners) l(stamped);
    return stamped;
  }
  since(seq = 0): Stamped[] {
    if (!existsSync(this.file)) return [];
    return readFileSync(this.file, "utf8").trimEnd().split("\n").filter(Boolean)
      .map(l => JSON.parse(l) as Stamped).filter(e => e.seq > seq);
  }
  subscribe(listener: (e: Stamped) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  get last(): number { return this.seq; }
}
