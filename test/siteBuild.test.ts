// site/build.ts — the extension downloads page and the builds it links.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITE_URL, appVersion, buildSite, checkFeedSignature, cubeParts, extensionId, feedName, minisignKeyId, releaseNotes, tarName, zipName } from "../site/build";

const EXT = join(import.meta.dir, "..", "clients", "browser-extension");

const CONF = join(import.meta.dir, "..", "desktop", "src-tauri", "tauri.conf.json");
const PINNED = JSON.parse(readFileSync(CONF, "utf8")).plugins.updater.pubkey as string;

/** A .sig in Tauri's shape (base64 of minisign's text form) from the key with
 * this id — the bytes after the id are not a real signature; only the build's
 * key check reads them. */
function fakeSig(keyId: string): string {
  const raw = Buffer.concat([Buffer.from("ED"), Buffer.from(keyId, "hex"), Buffer.alloc(64)]);
  return Buffer.from(`untrusted comment: signature from tauri secret key\n${raw.toString("base64")}\ntrusted comment: fake\n${Buffer.alloc(64).toString("base64")}\n`).toString("base64");
}

/** A stand-in bundle: enough shape for ditto, install.sh and `defaults read`. */
function fakeApp(dir: string, keyId: string = minisignKeyId(PINNED)): string {
  const app = join(dir, "BigBrain.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${appVersion()}</string></dict></plist>\n`
  );
  writeFileSync(join(app, "Contents", "MacOS", "bigbrain-desktop"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  // what `tauri build` leaves beside the .app when createUpdaterArtifacts
  // is on: the updater's tarball and its minisign signature
  writeFileSync(`${app}.tar.gz`, "fake updater tarball");
  writeFileSync(`${app}.tar.gz.sig`, `${fakeSig(keyId)}\n`);
  return app;
}

/** Run install.sh against the served dist — async, because the server
 * answering it lives in this very process and a sync spawn would starve it. */
async function runInstall(dist: string, port: number, into: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["sh", join(dist, "install.sh")], {
    env: { ...process.env, BIGBRAIN_BASE_URL: `http://127.0.0.1:${port}`, BIGBRAIN_INSTALL_DIR: into, BIGBRAIN_NO_OPEN: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out, err };
}

function zipList(path: string): string[] {
  const r = Bun.spawnSync(["unzip", "-Z1", path]);
  return r.stdout.toString().trim().split("\n");
}

describe("site build", () => {
  const out = mkdtempSync(join(tmpdir(), "bigbrain-site-"));
  const r = buildSite({ out, built: "2026-08-27" });
  const plugins = join(out, "plugins");
  const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
  process.on("exit", () => rmSync(out, { recursive: true, force: true }));

  test("names carry the manifest version", () => {
    expect(r.version).toBe(manifest.version);
    expect(r.chromeZip).toBe(`bigbrain-chrome-${manifest.version}.zip`);
    expect(r.firefoxXpi).toBe(`send_to_bigbrain-${manifest.version}-unsigned.xpi`);
    expect(r.chromeId).toBe(extensionId(manifest.key));
    expect(r.chromeId).toMatch(/^[a-p]{32}$/);
  });

  test("the zip is the extension minus the dev harness", () => {
    const files = zipList(join(plugins, r.chromeZip));
    expect(files).toContain("manifest.json");
    expect(files).toContain("LICENSE");
    expect(files).toContain("fonts/OFL.txt");
    expect(files).toContain("background.js");
    expect(files).toContain("options.html");
    expect(files).toContain("icons/icon128.png");
    expect(files).toContain("vendor/turndown.js");
    expect(files).toContain("fonts/hanken-grotesk-latin.woff2");
    for (const f of files) {
      expect(f).not.toMatch(/^(README\.md|preview\.html|web-ext-config\.cjs|stamp\.ts)$/);
      expect(f).not.toMatch(/^(icons-ink|web-ext-artifacts)\//);
      expect(f).not.toMatch(/\.DS_Store$/);
      expect(f).not.toMatch(/^_/); // Chrome refuses an underscore-prefixed file
    }
  });

  test("the xpi is the zip under another name", () => {
    const zip = readFileSync(join(plugins, r.chromeZip));
    const xpi = readFileSync(join(plugins, r.firefoxXpi));
    expect(xpi.equals(zip)).toBe(true);
    expect(zip.length).toBeGreaterThan(10_000);
  });

  test("the page links the existing stores and retains its local assets", () => {
    const html = readFileSync(join(plugins, "index.html"), "utf8");
    expect(html).not.toContain("{{");
    expect(html).toContain(`https://chromewebstore.google.com/detail/send-to-bigbrain/${r.chromeId}`);
    expect(html).toContain("https://addons.mozilla.org/en-US/firefox/addon/send-to-bigbrain/");
    expect(html).toContain(`Send to BigBrain ${r.version}`);
    expect(html).toContain(r.chromeId);
    expect(html).toContain("built 2026-08-27");
    for (const f of ["design.css", "bigbrain-mark-light.png", "fonts/hanken-grotesk-latin.woff2"]) {
      expect(existsSync(join(plugins, f))).toBe(true);
    }
    expect(existsSync(join(plugins, "fonts", "README.md"))).toBe(false);
  });

  test("release builds cannot contain the standalone website", () => {
    for (const name of ["index.html", "tokens.css", "fonts", "design.css"]) {
      expect(existsSync(join(out, name))).toBe(false);
    }
    expect(readdirSync(out).sort()).toEqual(["email", "plugins"]);
    expect(r.desktop).toBe(false);
    expect(r.sha256).toBeNull();
  });

  const mac = process.platform === "darwin";
  test.skipIf(!mac)("--app cuts the zip install.sh fetches, and install.sh carries its hash", () => {
    const dir = mkdtempSync(join(tmpdir(), "bigbrain-site-app-"));
    const app = fakeApp(dir);
    const r2 = buildSite({ out: join(dir, "dist"), built: "2026-08-27", desktopApp: app });
    expect(r2.desktop).toBe(true);
    const files = zipList(join(dir, "dist", "download", r2.zip));
    expect(files).toContain("BigBrain.app/Contents/Info.plist");
    expect(files).toContain("BigBrain.app/Contents/MacOS/bigbrain-desktop");
    expect(existsSync(join(dir, "dist", "download", r2.dmg))).toBe(false); // dmg: false
    const sh = readFileSync(join(dir, "dist", "install.sh"), "utf8");
    expect(sh).not.toContain("{{");
    expect(sh).toContain(`ZIP="${r2.zip}"`);
    expect(sh).toContain(`SHA256="${r2.sha256}"`);
    expect(sh).toContain(`BASE="\${BIGBRAIN_BASE_URL:-${SITE_URL}}"`);
    expect(r2.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Bun.spawnSync(["sh", "-n", join(dir, "dist", "install.sh")]).exitCode).toBe(0);
    expect(() => buildSite({ out: join(dir, "dist2"), desktopApp: join(dir, "Nope.app") })).toThrow(/not an app bundle/);
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!mac)("--app writes the app's update feed: the version, the tarball beside it, the signature verbatim", () => {
    const dir = mkdtempSync(join(tmpdir(), "bigbrain-site-upd-"));
    const app = fakeApp(dir);
    const r2 = buildSite({ out: join(dir, "dist"), built: "2026-08-27", desktopApp: app });
    expect(r2.tar).toBe(tarName(r2.appVersion));
    expect(r2.feed).toBe(feedName());
    // the 0.8.x feed is never rewritten by an ordinary release
    expect(existsSync(join(dir, "dist", "latest.json"))).toBe(false);
    const feed = JSON.parse(readFileSync(join(dir, "dist", r2.feed!), "utf8"));
    expect(feed.version).toBe(r2.appVersion);
    expect(feed.pub_date).toBe("2026-08-27T00:00:00Z");
    expect(feed.notes).toBe(releaseNotes(r2.appVersion));
    expect(feed.platforms["darwin-aarch64"].url).toBe(`${SITE_URL}/download/${r2.tar}`);
    // the signature is the .sig's content, trimmed — the updater hands it
    // straight to minisign, so any reformatting here would break every update
    expect(feed.platforms["darwin-aarch64"].signature).toBe(fakeSig(minisignKeyId(PINNED)));
    expect(readFileSync(join(dir, "dist", "download", r2.tar!), "utf8")).toBe("fake updater tarball");
    // a build cut without the updater artifacts must refuse, not quietly
    // ship an app that never sees another update
    rmSync(`${app}.tar.gz.sig`);
    expect(() => buildSite({ out: join(dir, "dist2"), desktopApp: app })).toThrow(/updater key/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("the app polls update.json; latest.json stays pinned to the first key", () => {
    expect(feedName()).toBe("update.json");
    const dir = mkdtempSync(join(tmpdir(), "bigbrain-site-conf-"));
    const conf = (endpoints: unknown): string => {
      const path = join(dir, `${Math.random()}.json`);
      writeFileSync(path, JSON.stringify({ version: "1.0.0", plugins: { updater: { endpoints } } }));
      return path;
    };
    expect(feedName(conf([`${SITE_URL}/update.json`]))).toBe("update.json");
    // a feed off the site, a nested path, or two feeds would ship an app whose
    // updates this build cannot publish
    expect(() => feedName(conf(["https://example.com/update.json"]))).toThrow(/endpoint/);
    expect(() => feedName(conf([`${SITE_URL}/download/update.json`]))).toThrow(/endpoint/);
    expect(() => feedName(conf([`${SITE_URL}/a.json`, `${SITE_URL}/b.json`]))).toThrow(/endpoint/);
    expect(() => feedName(conf(undefined))).toThrow(/endpoint/);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a release signed by a key its feed's apps do not pin is refused", () => {
    expect(minisignKeyId(PINNED)).toMatch(/^[0-9a-f]{16}$/);
    expect(() => checkFeedSignature(feedName(), fakeSig(minisignKeyId(PINNED)))).not.toThrow();
    expect(() => checkFeedSignature(feedName(), fakeSig("0011223344556677"))).toThrow(/not signed by the key/);
    // latest.json stays pinned to the first key whatever tauri.conf.json says now
    expect(() => checkFeedSignature("latest.json", fakeSig("ae31aca97f34b692"))).not.toThrow();
    expect(() => checkFeedSignature("latest.json", fakeSig("0011223344556677"))).toThrow(/not signed by the key/);
    expect(() => checkFeedSignature("elsewhere.json", fakeSig(minisignKeyId(PINNED)))).toThrow(/no public key/);
    expect(() => minisignKeyId("bm90IGEga2V5")).toThrow(/not a minisign/);
  });

  test.skipIf(!mac)("--feed publishes a rotation's bridge release on the previous feed only", () => {
    const dir = mkdtempSync(join(tmpdir(), "bigbrain-site-bridge-"));
    const app = fakeApp(dir, "ae31aca97f34b692"); // the bridge is signed by the first key
    const r2 = buildSite({ out: join(dir, "dist"), built: "2026-10-06", desktopApp: app, feed: "latest.json" });
    expect(r2.feed).toBe("latest.json");
    expect(existsSync(join(dir, "dist", feedName()))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, "dist", "latest.json"), "utf8")).version).toBe(r2.appVersion);
    expect(() => buildSite({ out: join(dir, "dist2"), desktopApp: app, feed: "../latest.json" })).toThrow(/not a feed name/);
    rmSync(dir, { recursive: true, force: true });
  });

  test.skipIf(!mac || process.arch !== "arm64")("install.sh, run against a local copy of the site, installs the app where it is told", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bigbrain-site-run-"));
    const app = fakeApp(dir);
    const dist = join(dir, "dist");
    buildSite({ out: dist, built: "2026-08-27", desktopApp: app });
    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => {
        requests.push(new URL(req.url).pathname);
        const path = join(dist, decodeURIComponent(new URL(req.url).pathname));
        return existsSync(path) ? new Response(Bun.file(path)) : new Response("nope", { status: 404 });
      },
    });
    try {
      const into = join(dir, "Applications");
      mkdirSync(into);
      const run = await runInstall(dist, server.port, into);
      expect(run.err + run.out).not.toContain("mismatch");
      expect(run.code).toBe(0);
      expect(run.out).toContain("installed BigBrain");
      expect(existsSync(join(into, "BigBrain.app", "Contents", "Info.plist"))).toBe(true);
      expect(readFileSync(join(into, "BigBrain.app", "Contents", "MacOS", "bigbrain-desktop"), "utf8")).toBe("#!/bin/sh\necho fake\n");
      // second run: replaces the one it installed
      const again = await runInstall(dist, server.port, into);
      expect(again.code).toBe(0);
      expect(again.out).toContain("replacing BigBrain");
      // a tampered zip is refused
      writeFileSync(join(dist, "download", zipName(appVersion())), "tampered");
      const bad = await runInstall(dist, server.port, into);
      expect(bad.code).toBe(1);
      expect(bad.err).toContain("checksum mismatch");
      expect(requests).toEqual(Array(3).fill(`/download/${zipName(appVersion())}`));
      expect(run.out + again.out + bad.out).not.toContain("diagnostics");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("cubeParts refuses a drop-in without its markers or parts", () => {
    expect(() => cubeParts("<html>nothing</html>")).toThrow(/DROP-IN/);
    expect(() => cubeParts("<!-- DROP-IN --><style>x</style><!-- /DROP-IN -->")).toThrow(/style \+ div/);
  });

  test("email/ is the pngs, never the templates", () => {
    const files = readdirSync(join(out, "email")).sort();
    expect(files).toEqual([
      "bigbrain-lockup-ink.png",
      "bigbrain-lockup-light.png",
      "bigbrain-mark-ink.png",
      "bigbrain-mark-light.png",
    ]);
  });

  test("extensionId derives Chrome's id from the SHIPPED key", () => {
    // The committed manifest key IS the extension's identity (site/build.ts):
    // the downloads page prints the id it derives, and a person checks it
    // against chrome://extensions after loading the build.
    const KEY = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8")).key as string;
    expect(extensionId(KEY)).toBe("ddnflabpbjfcakilfjmbinhblgbmckpb");
  });
});
