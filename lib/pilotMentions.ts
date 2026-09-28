/** Inline references use the vault's wiki-link notation in saved drafts/messages. */
export type MentionItem = { id: string; title: string; tag: "PILOT" | "SOURCE" | "MEMORY" | "ENTITY"; date?: string };
export type MentionPart = { text: string } | { mention: MentionItem };
export const mentionGlyph = (item: MentionItem): string => item.tag === "PILOT" ? "▼" : item.tag === "MEMORY" ? "◇" : "●";
export const mentionText = (parts: MentionPart[]): string => parts.map(p => "text" in p ? p.text : p.mention.title).join("");
const escape = (value: string) => value.replace(/[%[\]|\r\n]/g, c => encodeURIComponent(c));
const decode = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };
export const serializeMentions = (parts: MentionPart[]): string => parts.map(p => "text" in p ? p.text : `[[${escape(p.mention.id)}|${escape(p.mention.title)}]]`).join("");
export function parseMentions(text: string): MentionPart[] {
  const parts: MentionPart[] = [];
  let offset = 0;
  for (const match of text.matchAll(/\[\[([^\]\n|]+)\|([^\]\n]*)\]\]/g)) {
    if (match.index > offset) parts.push({ text: text.slice(offset, match.index) });
    const id = decode(match[1]!);
    parts.push({ mention: { id, title: decode(match[2]!), tag: id.startsWith("pilot-") ? "PILOT" : id.startsWith("memory/") ? "MEMORY" : id.startsWith("projection/entities/") ? "ENTITY" : "SOURCE" } });
    offset = match.index + match[0].length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
