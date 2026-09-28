import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAtomic } from "./fsx";
import { spoolDir } from "./spool";
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, type ChatImage } from "./chatImageTypes";

const types: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
function path(root: string, id: unknown): string {
  if (typeof id !== "string" || !/^[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(id)) throw new Error("Invalid image attachment.");
  return join(spoolDir(root), "chat-images", id);
}
export function readChatImage(root: string, id: unknown) {
  const bytes = readFileSync(path(root, id));
  return { bytes, mime: types[String(id).split(".").at(-1)!]! };
}
export function saveChatImage(root: string, data: unknown, name: unknown): ChatImage {
  if (typeof data !== "string" || data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4 + 100) throw new Error("Images must be 5 MB or smaller.");
  const match = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
  if (!match) throw new Error("Paste a PNG, JPEG, WebP, or GIF image.");
  const bytes = Buffer.from(match[2]!, "base64"), ext = match[1] === "jpeg" ? "jpg" : match[1]!;
  const valid = ext === "png" ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : ext === "jpg" ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : ext === "gif" ? ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString())
    : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid || bytes.length > MAX_CHAT_IMAGE_BYTES) throw new Error("Invalid or oversized image.");
  const id = `${createHash("sha256").update(bytes).digest("hex")}.${ext}`;
  createAtomic(path(root, id), bytes, 0o600);
  return { id, name: typeof name === "string" && name.trim() ? name.slice(0, 150) : `Pasted image.${ext}` };
}
export function validateChatImages(root: string, value: unknown): ChatImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES) throw new Error(`Attach at most ${MAX_CHAT_IMAGES} images.`);
  return value.map(v => {
    if (!v || typeof v.name !== "string" || v.name.length > 150) throw new Error("Invalid image attachment.");
    readChatImage(root, v.id);
    return { id: v.id as string, name: v.name };
  });
}
export function chatImageData(root: string, image: ChatImage): string {
  const { bytes, mime } = readChatImage(root, image.id);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
export const modelImages = (root: string, images: ChatImage[] = []) => images.map(image => ({ type: "image", url: chatImageData(root, image) }));
