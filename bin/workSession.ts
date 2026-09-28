#!/usr/bin/env bun
/** Read-only terminal observation; never starts another agent. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spoolDir } from "../lib/spool";
import type { WorkSession } from "../lib/workHistory";
const [root, id] = process.argv.slice(2);
if (!root || !id || !/^work-[a-f0-9]{32}$/.test(id)) {
  console.error("Usage: bun bin/workSession.ts <vault> <work-session-id>"); process.exit(2);
}
const shown = new Map<string, string>();
let status = "";
for (;;) {
  const job = JSON.parse(readFileSync(join(spoolDir(root), "work-sessions", `${id}.json`), "utf8")) as WorkSession;
  for (const message of job.messages) {
    const prior = shown.get(message.id);
    if (prior === message.text) continue;
    if (prior === undefined) process.stdout.write(`\n${message.role}: ${message.text}`);
    else process.stdout.write(message.text.startsWith(prior) ? message.text.slice(prior.length) : `\n${message.text}`);
    shown.set(message.id, message.text);
  }
  if (job.status !== status) { status = job.status; process.stdout.write(`\n[${status}]\n`); }
  if (!["starting", "working", "needs-input"].includes(status)) break;
  await Bun.sleep(750);
}
