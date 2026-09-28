import { expect, test } from "bun:test";
import { claudeProviderConnected } from "../lib/providerConnection";

test("Claude provider login is independent of optional plugin credentials", () => {
  const claude = { installed: "1.0", account: "fixture@example.com", connected: true };
  expect(claudeProviderConnected({ claude })).toBe(true);
  expect(claudeProviderConnected({ claude, agent: { revoked: "2026-09-19" } })).toBe(true);
  expect(claudeProviderConnected({ claude: { ...claude, account: null } })).toBe(false);
  expect(claudeProviderConnected({ claude: { ...claude, installed: false } })).toBe(false);
  expect(claudeProviderConnected({ claude: { ...claude, connected: false }, agent: { revoked: null } })).toBe(false);
});
