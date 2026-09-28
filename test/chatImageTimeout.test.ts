import { expect, test } from "bun:test";
import { boundedImageUpload } from "../web/ui/src/lib/boundedImageUpload";
test("upload timeout aborts hung transport and permits caller cleanup", async () => {
  let signal: AbortSignal | undefined;
  await expect(boundedImageUpload(s => { signal = s; return new Promise(() => {}); }, 5)).rejects.toThrow("timed out");
  expect(signal?.aborted).toBe(true);
  expect(await boundedImageUpload(async () => "retry", 50)).toBe("retry");
});
