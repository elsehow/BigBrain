/**
 * pilotTaskName.ts — a pilot session's name, by the Quick model.
 *
 * A session is a task, and its name should read like one: a few plain words
 * that name the subject ("Sourdough starter feeding schedule"), not the first
 * line of the first message. The engine asks Quick as the conversation
 * develops — at the 1st, 2nd, 4th, 8th… user message, so a name settles rather
 * than churns — and stops for good once a person renames the session by hand
 * (titleSource "human", lib/pilotChat.ts rename()).
 */
import { runBriefingModel } from "./entityBriefing";

export const TASK_NAME_SYSTEM = `Come up with a name for this task, the way a chat app titles a conversation.
A few words (usually two to six), plain and specific. Name the subject; don't echo the person's words or start with a verb like "Discussing".
Sentence case. No quotes, no trailing punctuation, no emoji.
Examples: Sourdough starter feeding schedule · Replace a cracked phone screen at home · Weekly meal plan for two · Copper prices: Chile vs Peru · Citation style for a workshop paper
Reply with the name only.`;

export interface NamedMessage { role: "user" | "assistant"; text: string }

const clip = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n - 1) + "…");

/** The conversation as Quick sees it: how it began, where it is now, and the name so far. */
export function taskNamePrompt(messages: readonly NamedMessage[], current?: string): string {
  const first = messages.find((m) => m.role === "user");
  const recent = messages.slice(-4).filter((m) => m !== first);
  const lines = [
    ...(first ? [`It began: ${clip(first.text, 800)}`] : []),
    ...recent.map((m) => `${m.role === "user" ? "Person" : "Assistant"}: ${clip(m.text, 500)}`),
    ...(current && !["New session", "Draft session"].includes(current) ? [`Its name so far: ${current}`] : []),
  ];
  return `${lines.join("\n\n")}\n\nName this task.`;
}

/** Quick's reply, tidied into a name — or null when it isn't one. */
export function cleanTaskName(raw: string): string | null {
  let t = (raw.split("\n").find((l) => l.trim()) ?? "").trim();
  t = t.replace(/^(name|title|task)\s*:\s*/i, "").replace(/^["'“‘`*]+|["'”’`*]+$/g, "").replace(/[.!?;,:]+$/, "").replace(/\s+/g, " ").trim();
  if (!t || t.split(" ").length > 12) return null;
  if (t.length > 72) t = t.slice(0, 71).replace(/\s+\S*$/, "");
  return t || null;
}

export type TaskNamer = (root: string, messages: readonly NamedMessage[], current?: string) => Promise<string | null>;

export const nameTask: TaskNamer = async (root, messages, current) => {
  try {
    const result = await runBriefingModel(root, taskNamePrompt(messages, current), () => {}, TASK_NAME_SYSTEM);
    return cleanTaskName(result.text);
  } catch {
    return null;
  }
};

/** Re-name at the 1st, 2nd, 4th, 8th… user message. */
export const namingMoment = (userMessages: number): boolean => userMessages > 0 && (userMessages & (userMessages - 1)) === 0;
