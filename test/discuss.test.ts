import { describe, expect, test } from "bun:test";
import { copyDiscussPrompt } from "../web/ui/src/lib/discuss";

// discussLine's own spelling is covered by test/discussLine.test.ts (it
// also ties the extension popup's literal and the plugin manifest to this
// same file). This suite covers copyDiscussPrompt's ritual — the clipboard
// write, the copied-state flash and its 1600ms reset — that HomeView and
// VaultView both delegate to (#265).
describe("copyDiscussPrompt", () => {
  const stubClipboard = (impl: (text: string) => Promise<void>) => {
    (globalThis as unknown as { navigator: unknown }).navigator = {
      clipboard: { writeText: impl },
    };
  };

  test("writes the plugin-command line, flashes copied, then clears it after 1600ms", async () => {
    const written: string[] = [];
    stubClipboard(async (t) => {
      written.push(t);
    });
    const flashes: boolean[] = [];
    await copyDiscussPrompt("inbox/x.md", (c) => flashes.push(c));
    expect(written).toEqual(["/bigbrain:discuss inbox/x.md"]);
    expect(flashes).toEqual([true]);

    // the reset is scheduled via setTimeout(1600) — real timers, fast-forwarded
    await Bun.sleep(1650);
    expect(flashes).toEqual([true, false]);
  });

  test("a clipboard failure (non-secure context) is silent — no confirmation flash", async () => {
    stubClipboard(async () => {
      throw new Error("clipboard unavailable");
    });
    const flashes: boolean[] = [];
    await copyDiscussPrompt("inbox/x.md", (c) => flashes.push(c));
    expect(flashes).toEqual([]);
  });
});
