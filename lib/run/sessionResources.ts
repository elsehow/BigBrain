import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { spoolDir } from "../spool";
import type { ModelSessionSetup } from "./session";

export function sessionRuntimeDirectory(setup: ModelSessionSetup): string {
  setup.state.runtimeId ??= crypto.randomUUID();
  if (!/^[\da-f-]{36}$/.test(setup.state.runtimeId)) throw new Error("Invalid Pilot runtime identity.");
  const path = join(spoolDir(setup.root), "pilot-engines", setup.state.runtimeId);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  setup.save();
  return path;
}
export function sessionImages(images: { type: string; url: string }[] = []) {
  return images.map(image => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(image.url);
    if (!match) throw new Error("Invalid Pilot image.");
    return { mime: match[1]!, data: match[2]! };
  });
}
