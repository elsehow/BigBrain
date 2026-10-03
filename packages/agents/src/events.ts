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
  | { type: "project.forked"; project: string; branch: string; path: string; ms: number }
  | { type: "project.discarded"; project: string }
  | { type: "server.started"; port: number; job: number; command: string }
  | { type: "server.exited"; job: number; code: number | null }
  | { type: "homecopy.changed"; project: string; files: number }
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
    // Deltas are for live viewers only: the finished message is the durable
    // record, so a delta carries the last durable seq and is never written.
    const live = event.type === "message.delta";
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
