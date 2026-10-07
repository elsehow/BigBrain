/**
 * Build release assets only: plugins/, email/, and (with --app) download/,
 * install.sh and the update feed. The homepage lives in elsehow/bigbrain.cool.
 * Publish with site/deploy.sh to /srv/releases, never the website root.
 */

import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { flagValue, hasFlag } from "../lib/cliflags";

const ENGINE = join(import.meta.dir, "..");
const EXT_SRC = join(ENGINE, "clients", "browser-extension");
const CUBE_SRC = join(ENGINE, "docs", "design", "mark", "bigbrain-cube.html");
const DESKTOP_CONF = join(ENGINE, "desktop", "src-tauri", "tauri.conf.json");
const RELEASES = join(ENGINE, "docs", "releases");

/** The animated mark's three parts, cut from the drop-in page between its
 * DROP-IN comments — verbatim, so the site never carries a second copy of
 * the cube. The div's own aria (`role="img"`, a label) goes: on the site it
 * sits beside the wordmark, which already says the name. */
export function cubeParts(html: string = readFileSync(CUBE_SRC, "utf8")): { style: string; markup: string; script: string } {
  const start = html.indexOf("DROP-IN");
  const end = html.indexOf("/DROP-IN");
  if (start < 0 || end < 0) throw new Error(`${CUBE_SRC}: no DROP-IN markers`);
  const part = html.slice(start, end);
  const style = /<style>([\s\S]*?)<\/style>/.exec(part)?.[1];
  const div = /<div class="bb-cube"[^>]*>[\s\S]*?<\/div>/.exec(part)?.[0];
  const script = /<script>([\s\S]*?)<\/script>/.exec(part)?.[1];
  if (!style || !div || !script) throw new Error(`${CUBE_SRC}: the drop-in is not style + div.bb-cube + script`);
  const markup = div.replace(/<div class="bb-cube"[^>]*>/, '<div class="bb-cube" aria-hidden="true">').replace(/\s+/g, " ").replace(/> </g, "><");
  return { style: style.trim(), markup, script: script.trim() };
}

/** The desktop app's version — tauri.conf.json is where `tauri build`
 * reads it, so the .dmg it names is the one that build cuts. */
export function appVersion(conf: string = DESKTOP_CONF): string {
  const v = (JSON.parse(readFileSync(conf, "utf8")) as { version?: unknown }).version;
  if (typeof v !== "string" || !/^\d+(\.\d+)*$/.test(v)) throw new Error(`${conf}: version is not a version: ${String(v)}`);
  return v;
}

/** The updater shows the same prose as the GitHub release. The heading is
 * metadata there; the installed app needs only the body. */
export function releaseNotes(version: string, dir: string = RELEASES): string {
  const file = join(dir, `${version}.md`);
  if (!existsSync(file)) throw new Error(`no release notes for desktop ${version}: ${file}`);
  const [heading, ...body] = readFileSync(file, "utf8").trim().split("\n");
  if (heading !== `# BigBrain ${version}`) throw new Error(`${file}: expected heading # BigBrain ${version}`);
  const notes = body.join("\n").trim();
  if (!notes) throw new Error(`${file}: release notes are empty`);
  return notes;
}

/** The update feed an app built from `conf` polls: the file its updater
 * endpoint names. A signing key rotates by moving the feed — an installed
 * app keeps polling the feed it shipped with, and only the key it pins can
 * sign what lands there. */
export function feedName(conf: string = DESKTOP_CONF): string {
  const endpoints = (JSON.parse(readFileSync(conf, "utf8")) as { plugins?: { updater?: { endpoints?: unknown } } }).plugins?.updater?.endpoints;
  const url = Array.isArray(endpoints) && endpoints.length === 1 && typeof endpoints[0] === "string" ? URL.parse(endpoints[0]) : null;
  if (!url || url.origin !== SITE_URL || !/^\/[a-z0-9-]+\.json$/.test(url.pathname)) throw new Error(`${conf}: the updater needs exactly one endpoint, a feed on ${SITE_URL}`);
  return url.pathname.slice(1);
}

/** The public key each retired feed's apps pin. A feed not listed here is
 * the current one, pinned by tauri.conf.json's own pubkey. */
const FEED_KEYS: Record<string, string> = {
  "latest.json": "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDkyQjYzNDdGQTlBQzMxQUUKUldTdU1heXBmelMya2xndHF1TEhJalZpanVlVFdudFBqU3BaaXl0Zm95RHpvcUhNL1hURWQ1MGYK",
};

/** The key id inside a Tauri pubkey or .sig: both are base64 of minisign's
 * text form, whose second line is base64 of a 2-byte algorithm, the 8-byte
 * key id, then the key or signature. */
export function minisignKeyId(b64: string): string {
  const line = Buffer.from(b64.trim(), "base64").toString("utf8").split("\n")[1]?.trim();
  const raw = line ? Buffer.from(line, "base64") : null;
  if (!raw || raw.length < 42) throw new Error("not a minisign key or signature");
  return raw.subarray(2, 10).toString("hex");
}

/** A release signed by a key other than the one its feed's apps pin would
 * publish fine and then fail every install's check, silently. Refuse it here. */
export function checkFeedSignature(feed: string, signature: string, conf: string = DESKTOP_CONF): void {
  const pinned = FEED_KEYS[feed] ?? (feed === feedName(conf) ? (JSON.parse(readFileSync(conf, "utf8")) as { plugins: { updater: { pubkey: string } } }).plugins.updater.pubkey : undefined);
  if (!pinned) throw new Error(`no public key is known for the feed ${feed}`);
  if (minisignKeyId(signature) !== minisignKeyId(pinned)) throw new Error(`the update is not signed by the key ${feed}'s apps pin — check TAURI_SIGNING_PRIVATE_KEY (desktop/README.md, key rotation)`);
}

export const dmgName = (version: string): string => `BigBrain_${version}_aarch64.dmg`;
export const zipName = (version: string): string => `BigBrain_${version}_aarch64.zip`;
export const tarName = (version: string): string => `BigBrain_${version}_aarch64.app.tar.gz`;

/** Where the site lives — what install.sh fetches from, and what the page
 * tells people to curl. */
export const SITE_URL = "https://bigbrain.exe.xyz";

/** Cut the two downloads from a built .app: the zip install.sh fetches
 * (`ditto -c -k --keepParent`, the archive macOS itself makes), and — when
 * asked — the .dmg with the Applications link (hdiutil). Both macOS tools;
 * the site is built on the Mac that built the app. */
export function cutDownloads(
  app: string,
  dir: string,
  version: string,
  opts: { dmg: boolean }
): { zip: string; dmg: string | null; sha256: string; tar: string; signature: string } {
  if (!existsSync(join(app, "Contents", "Info.plist"))) throw new Error(`not an app bundle: ${app}`);
  // The updater's food, made by `tauri build` beside the .app when
  // createUpdaterArtifacts is on and TAURI_SIGNING_PRIVATE_KEY points
  // at the key (desktop/README.md). Required, not optional: a release cut
  // without them would ship an app whose installed copies silently never
  // see another update.
  const madeTar = `${app}.tar.gz`;
  for (const f of [madeTar, `${madeTar}.sig`]) {
    if (!existsSync(f)) {
      throw new Error(`no ${f} — build the app with the updater key: TAURI_SIGNING_PRIVATE_KEY=<the signing key> bun run build (desktop/README.md)`);
    }
  }
  mkdirSync(dir, { recursive: true });
  const tar = tarName(version);
  copyFileSync(madeTar, join(dir, tar));
  const signature = readFileSync(`${madeTar}.sig`, "utf8").trim();
  const zip = zipName(version);
  const zipped = Bun.spawnSync(["ditto", "-c", "-k", "--keepParent", app, join(dir, zip)], { stderr: "pipe" });
  if (zipped.exitCode !== 0) throw new Error(`ditto failed: ${zipped.stderr.toString()}`);
  const sha256 = createHash("sha256").update(readFileSync(join(dir, zip))).digest("hex");
  let dmg: string | null = null;
  if (opts.dmg) {
    dmg = dmgName(version);
    const stage = mkdtempSync(join(tmpdir(), "bigbrain-dmg-"));
    try {
      cpSync(app, join(stage, "BigBrain.app"), { recursive: true, verbatimSymlinks: true });
      symlinkSync("/Applications", join(stage, "Applications"));
      const made = Bun.spawnSync(
        ["hdiutil", "create", "-quiet", "-volname", "BigBrain", "-srcfolder", stage, "-ov", "-format", "UDZO", join(dir, dmg)],
        { stderr: "pipe" }
      );
      if (made.exitCode !== 0) throw new Error(`hdiutil failed: ${made.stderr.toString()}`);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  return { zip, dmg, sha256, tar, signature };
}

/** Never in a build: the dev harness, docs, the web-ext config, and the
 * ink icon sources (icons/ is what ships). Top-level names only. */
const EXCLUDE = new Set(["web-ext-artifacts", "README.md", "web-ext-config.cjs", "preview.html", "icons-ink"]);

/** Chrome's id derivation: sha256 over the DER public key, first 16 bytes,
 * each nibble 0–f → a–p. The id a user sees on chrome://extensions. */
export function extensionId(keyB64: string): string {
  const hex = createHash("sha256").update(Buffer.from(keyB64, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
}

export interface BuildOpts {
  /** Where dist lands. Created; a previous build there is removed. */
  out: string;
  /** Extension source (defaults to clients/browser-extension). */
  extSrc?: string;
  /** The date stamped on the page, YYYY-MM-DD. */
  built?: string;
  /** The built BigBrain.app: the zip and the .dmg at /download/ are cut
   * from it, and install.sh is rendered against the zip. */
  desktopApp?: string;
  /** Cut the .dmg too (hdiutil; slow) — the CLI does, tests do not. */
  dmg?: boolean;
  /** The bridge release of a key rotation, signed by the previous key, goes
   * on the previous feed (desktop/README.md) instead of the one its own
   * config names. Apps up to 0.8.x poll latest.json. */
  feed?: string;
  /** The cube drop-in and the desktop config (tests point them elsewhere). */
  cubeSrc?: string;
  desktopConf?: string;
}

export interface BuildResult {
  version: string;
  chromeId: string;
  chromeZip: string;
  firefoxXpi: string;
  /** The desktop app's version, and the downloads named from it. */
  appVersion: string;
  zip: string;
  dmg: string;
  /** The zip's sha256 (what install.sh checks) — null without `desktopApp`. */
  sha256: string | null;
  /** The updater's tarball at /download/, named in the feed — null without `desktopApp`. */
  tar: string | null;
  /** The update feed written at the root of dist — null without `desktopApp`. */
  feed: string | null;
  /** Whether download/ and install.sh are in dist (a `desktopApp` was handed in). */
  desktop: boolean;
  out: string;
}

export function buildSite(opts: BuildOpts): BuildResult {
  const extSrc = opts.extSrc ?? EXT_SRC;
  const manifest = JSON.parse(readFileSync(join(extSrc, "manifest.json"), "utf8")) as { version: string; key: string };
  const version = manifest.version;
  if (!/^\d+(\.\d+)*$/.test(version)) throw new Error(`manifest version is not a version: ${version}`);
  const chromeId = extensionId(manifest.key);
  const chromeZip = `bigbrain-chrome-${version}.zip`;
  const firefoxXpi = `send_to_bigbrain-${version}-unsigned.xpi`;
  const built = opts.built ?? new Date().toISOString().slice(0, 10);

  const version_app = appVersion(opts.desktopConf);
  const zip = zipName(version_app);
  const dmg = dmgName(version_app);
  if (opts.desktopApp && !existsSync(join(opts.desktopApp, "Contents", "Info.plist"))) throw new Error(`not an app bundle: ${opts.desktopApp}`);

  const out = opts.out;
  rmSync(out, { recursive: true, force: true });
  const plugins = join(out, "plugins");
  mkdirSync(plugins, { recursive: true });

  // Extension page stylesheet, fonts, and mark.
  const assets = (dir: string): void => {
    copyFileSync(join(extSrc, "design.css"), join(dir, "design.css"));
    cpSync(join(extSrc, "fonts"), join(dir, "fonts"), { recursive: true, filter: (src) => !src.endsWith(".md") });
    copyFileSync(join(ENGINE, "brand", "email", "bigbrain-mark-light.png"), join(dir, "bigbrain-mark-light.png"));
  };
  const render = (tpl: string, vars: Record<string, string>): string =>
    tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k: string) => {
      if (!(k in vars)) throw new Error(`template names ${m}, which the build does not supply`);
      return vars[k]!;
    });

  // The extension page shares the app's animated mark.
  const cube = cubeParts(opts.cubeSrc ? readFileSync(opts.cubeSrc, "utf8") : undefined);
  let sha256: string | null = null;
  let tar: string | null = null;
  let feed: string | null = null;
  if (opts.desktopApp) {
    const cut = cutDownloads(opts.desktopApp, join(out, "download"), version_app, { dmg: opts.dmg ?? false });
    sha256 = cut.sha256;
    tar = cut.tar;
    writeFileSync(
      join(out, "install.sh"),
      render(readFileSync(join(import.meta.dir, "install.sh"), "utf8"), { APP_VERSION: version_app, ZIP: cut.zip, ZIP_SHA256: sha256, SITE_URL })
    );
    // What installed apps poll (tauri-plugin-updater; the endpoint baked
    // into desktop/src-tauri/tauri.conf.json). Uploading dist/ IS the
    // release: the moment this file lands, every running app's next check
    // says a newer version exists.
    feed = opts.feed ?? feedName(opts.desktopConf);
    if (!/^[a-z0-9-]+\.json$/.test(feed)) throw new Error(`not a feed name: ${feed}`);
    checkFeedSignature(feed, cut.signature, opts.desktopConf);
    writeFileSync(
      join(out, feed),
      `${JSON.stringify(
        {
          version: version_app,
          pub_date: `${built}T00:00:00Z`,
          notes: releaseNotes(version_app),
          platforms: { "darwin-aarch64": { signature: cut.signature, url: `${SITE_URL}/download/${cut.tar}` } },
        },
        null,
        2
      )}\n`
    );
  }

  // stage a clean copy, then zip THAT — the zip then contains exactly what
  // the filter let through, with no exclude-pattern arithmetic and no
  // .DS_Store from a checkout that has been opened in Finder
  const stage = mkdtempSync(join(tmpdir(), "bigbrain-ext-"));
  try {
    const staged = join(stage, "ext");
    cpSync(extSrc, staged, {
      recursive: true,
      filter: (src) => {
        const name = basename(src);
        if (name === ".DS_Store") return false;
        return src === extSrc || !(EXCLUDE.has(name) && join(extSrc, name) === src);
      },
    });
    copyFileSync(join(ENGINE, "LICENSE"), join(staged, "LICENSE"));
    const zipPath = join(plugins, chromeZip);
    const zip = Bun.spawnSync(["zip", "-qrX", zipPath, "."], { cwd: staged, stderr: "pipe" });
    if (zip.exitCode !== 0) throw new Error(`zip failed: ${zip.stderr.toString()}`);
    copyFileSync(zipPath, join(plugins, firefoxXpi));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  // the page, and what it renders with
  const tpl = readFileSync(join(import.meta.dir, "plugins", "index.html"), "utf8");
  const vars: Record<string, string> = {
    VERSION: version,
    CHROME_ID: chromeId,
    CHROME_ZIP: chromeZip,
    FIREFOX_XPI: firefoxXpi,
    BUILT: built,
    CUBE_STYLE: cube.style,
    CUBE_MARKUP: cube.markup,
    CUBE_SCRIPT: cube.script,
  };
  writeFileSync(join(plugins, "index.html"), render(tpl, vars));
  assets(plugins);

  // the mail assets: png only, names untouched (brand/README.md)
  const emailSrc = join(ENGINE, "brand", "email");
  const email = join(out, "email");
  mkdirSync(email);
  for (const f of readdirSync(emailSrc)) if (f.endsWith(".png")) copyFileSync(join(emailSrc, f), join(email, f));

  return { version, chromeId, chromeZip, firefoxXpi, appVersion: version_app, zip, dmg, sha256, tar, feed, desktop: Boolean(opts.desktopApp), out };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = flagValue(args, "out") ?? join(ENGINE, "site", "dist");
  if (!existsSync(EXT_SRC)) throw new Error(`no extension source at ${EXT_SRC}`);
  const r = buildSite({ out, desktopApp: flagValue(args, "app"), dmg: !hasFlag(args, "no-dmg"), feed: flagValue(args, "feed") });
  console.log(`site → ${r.out}`);
  console.log("  Release assets only; homepage is owned by elsehow/bigbrain.cool.");
  if (r.desktop) {
    console.log(`  install.sh   (fetches download/${r.zip}, sha256 ${r.sha256})`);
    console.log(`  ${r.feed}  (the update feed: v${r.appVersion}, download/${r.tar})`);
    console.log(`  download/${r.tar}`);
    console.log(`  download/${r.zip}`);
    if (existsSync(join(r.out, "download", r.dmg))) console.log(`  download/${r.dmg}`);
  }
  console.log(`  plugins/${r.chromeZip}   (chrome id ${r.chromeId})`);
  console.log(`  plugins/${r.firefoxXpi}`);
  console.log(`  plugins/index.html   (v${r.version})`);
  console.log(`  email/*.png`);
}
