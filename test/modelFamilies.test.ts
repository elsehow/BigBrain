import { expect, test } from "bun:test";
import { latestPerFamily } from "../web/ui/src/lib/v2/model";

const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

test("each family's newest model leads; the rest are other", () => {
  const models = ["claude-fable-5", "claude-fable-5-1", "claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-opus-4-5", "claude-opus-4-5-20251101",
    "claude-opus-4-8", "claude-opus-5", "claude-opus-5-5", "claude-sonnet-4-5-20250929", "claude-sonnet-5-5",
    "gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.6-sol", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"].map((id) => ({ id }));
  const { latest, other } = latestPerFamily(models);
  expect(ids(latest)).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-5-5", "claude-sonnet-5-5", "gpt-5.3-codex-spark", "gpt-5.5", "gpt-6.1-sol", "gpt-6-luna"]);
  expect(other).toHaveLength(models.length - latest.length);
});

test("a family with only a dated snapshot still shows it", () => {
  expect(ids(latestPerFamily([{ id: "claude-sonnet-4-5-20250929" }]).latest)).toEqual(["claude-sonnet-4-5-20250929"]);
});
