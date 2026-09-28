import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTokens, verifyToken } from "../lib/auth";
import {
  CONNECT_TOKEN_NAME,
  CONNECT_TOKEN_SCOPES,
  LOCAL_API_BASE,
  connectLocal,
  connectTokenName,
  pluginInstallCommands,
  pluginRefreshCommands,
} from "../lib/connect";

const tmp = () => mkdtempSync(join(tmpdir(), "bb-connect-"));

function stores() {
  const dir = tmp();
  return {
    root: join(dir, "vault"),
    storePath: join(dir, "tokens.json"),
    clientPath: join(dir, "client-tokens.json"),
  };
}

describe("connectTokenName", () => {
  test("keeps the bb.sh tiebreak prefix and sanitizes the machine", () => {
    expect(connectTokenName("nicks-macbook.local")).toBe("claude code on nicks-macbook.local");
    expect(connectTokenName("weird host!/name")).toBe("claude code on weirdhostname");
    expect(connectTokenName("")).toBe(CONNECT_TOKEN_NAME);
    expect(connectTokenName("x".repeat(80))).toBe(`claude code on ${"x".repeat(40)}`);
  });
});

describe("connectLocal", () => {
  test("mints an agent token for the owner, saves it under the local base", () => {
    const s = stores();
    const res = connectLocal({ ...s, owner: "nick@example.com", machine: "laptop" });

    expect(res.name).toBe("claude code on laptop");
    expect(res.url).toBe(LOCAL_API_BASE);
    expect(res.superseded).toEqual([]);
    expect(res.token.startsWith("bb_")).toBe(true);

    const [rec] = listTokens(s.storePath);
    expect(rec).toMatchObject({
      id: res.id,
      name: "claude code on laptop",
      owner: "nick@example.com",
      kind: "agent",
      via: "connect",
      scopes: [...CONNECT_TOKEN_SCOPES],
    });
    expect(verifyToken(s.storePath, res.token).ok).toBe(true);

    const client = JSON.parse(readFileSync(s.clientPath, "utf8")) as Record<
      string,
      { token: string; name: string }
    >;
    expect(client[LOCAL_API_BASE]).toMatchObject({ token: res.token, name: "claude code on laptop" });
  });

  test("reconnecting supersedes the machine's live token and rewrites the client entry", () => {
    const s = stores();
    const first = connectLocal({ ...s, owner: "nick@example.com", machine: "laptop" });
    const second = connectLocal({ ...s, owner: "nick@example.com", machine: "laptop" });

    expect(second.superseded).toEqual([first.id]);
    expect(verifyToken(s.storePath, first.token).ok).toBe(false);
    expect(verifyToken(s.storePath, second.token).ok).toBe(true);

    const client = JSON.parse(readFileSync(s.clientPath, "utf8")) as Record<string, { token: string }>;
    expect(client[LOCAL_API_BASE]!.token).toBe(second.token);
  });

  test("a different machine's token is left alone; --url is normalized", () => {
    const s = stores();
    const other = connectLocal({ ...s, owner: "nick@example.com", machine: "desktop" });
    const res = connectLocal({
      ...s,
      owner: "nick@example.com",
      machine: "laptop",
      url: "https://vault.example.com/",
    });
    expect(res.superseded).toEqual([]);
    expect(res.url).toBe("https://vault.example.com");
    expect(verifyToken(s.storePath, other.token).ok).toBe(true);
    expect(listTokens(s.storePath)).toHaveLength(2);
  });
});

describe("pluginInstallCommands", () => {
  test("installs from the engine's own tree as a directory source, user scope — and refreshes an existing install", () => {
    const cmds = pluginInstallCommands("/srv/engine");
    expect(cmds).toEqual([
      ["claude", "plugin", "marketplace", "add", "/srv/engine/clients/claude-plugin"],
      ["claude", "plugin", "install", "bigbrain@bigbrain", "--scope", "user"],
      ["claude", "plugin", "marketplace", "update", "bigbrain"],
      ["claude", "plugin", "update", "bigbrain@bigbrain", "--scope", "user", "--yes"],
    ]);
  });

  test("the refresh is the same minus the install", () => {
    expect(pluginRefreshCommands("/srv/engine").map((c) => c[2])).toEqual(["marketplace", "marketplace", "update"]);
    expect(pluginRefreshCommands("/srv/engine")).not.toContainEqual(expect.arrayContaining(["install"]));
  });
});
