import { boundedImageUpload } from "./boundedImageUpload";
import { vaultStorageKey } from "./vaultScope";
import { vaultFetch as fetch } from "./vaultScope";
import { MAX_CHAT_IMAGES, MAX_CHAT_IMAGE_BYTES, type ChatImage } from "../../../../lib/chatImageTypes";
const drafts = $state<Record<string, ChatImage[]>>({});
export const imageUploads = $state<Record<string, { busy: boolean; error: string }>>({});
export function restoreDraftImages(id: string, images: ChatImage[] = []) {
  if (drafts[id] !== undefined) return;
  try { if (sessionStorage.getItem(vaultStorageKey(`chat-images:${id}`)) !== null) return; } catch { /* use saved draft */ }
  if (images.length) setDraftImages(id, images);
}
export function draftImages(id: string): ChatImage[] {
  if (drafts[id]) return drafts[id];
  try { return JSON.parse(sessionStorage.getItem(vaultStorageKey(`chat-images:${id}`)) ?? "[]"); } catch { return []; }
}
export function setDraftImages(id: string, images: ChatImage[]) {
  drafts[id] = images;
  try { sessionStorage.setItem(vaultStorageKey(`chat-images:${id}`), JSON.stringify(images)); } catch { /* in-memory draft retained */ }
}
export function pasteImages(id: string, e: ClipboardEvent): boolean {
  const files = [...(e.clipboardData?.items ?? [])].filter(i => i.kind === "file" && i.type.startsWith("image/")).map(i => i.getAsFile()).filter((f): f is File => !!f);
  if (!files.length) return false;
  e.preventDefault();
  void uploadImages(id, files);
  return true;
}
async function uploadImages(id: string, files: File[]) {
  if (imageUploads[id]?.busy) return;
  imageUploads[id] = { busy: true, error: "" };
  try {
    if (draftImages(id).length + files.length > MAX_CHAT_IMAGES) throw new Error(`Attach at most ${MAX_CHAT_IMAGES} images.`);
    for (const file of files) {
      if (file.size > MAX_CHAT_IMAGE_BYTES) throw new Error("Images must be 5 MB or smaller.");
      const image = await boundedImageUpload(async signal => {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Image could not be read.")); signal.addEventListener("abort", () => { reader.abort(); reject(new Error("Image upload timed out. Please try again.")); }, { once: true }); reader.readAsDataURL(file);
      });
      const response = await fetch("/api/pilot/chat/image", { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, name: file.name }) });
      const image = await response.json();
      if (!response.ok) throw new Error(image.error ?? "Image could not be attached.");
      return image;
      });
      setDraftImages(id, [...draftImages(id), image]);
    }
  } catch (e) { imageUploads[id].error = (e as Error).message; }
  finally { imageUploads[id].busy = false; }
}
