/**
 * THE MARK, MOVING, AS VIDEO — for CapCut and the like.
 *
 * Screenshots the workbench's render stage (web/ui/src/dev/LogomarkRender.svelte)
 * frame by frame through this machine's Chrome, then cuts two files with
 * ffmpeg:
 *
 *   <name>.mov   ProRes 4444, transparent — drop it over anything
 *   <name>.mp4   H.264 on the theme's own background — the safe one
 *
 * and leaves the PNG frames beside them. Needs the dev server up
 * (`bun run web:dev`), ffmpeg on PATH, and Chrome installed — playwright-core
 * (a dev dependency) drives it; PLAYWRIGHT_MODULE overrides the module.
 *
 *   bun run logomark:render -- --list
 *   bun run logomark:render -- --theme dusk --wordmark --out ~/Desktop/mark
 *
 * Options (all optional):
 *   --list           the themes, by the name Settings › Theme shows and by id
 *   --theme <name>   a theme, by that name or id; default "default" (Ink, light)
 *   --loop <name>    flip | walk | column, default flip
 *   --size <px>      the mark's height, default 1024
 *   --fps <n>        default 60
 *   --seconds <n>    default one pass of the loop (a whole number of passes loops seamlessly)
 *   --wordmark       the lockup: the mark with "BigBrain" beside it
 *   --turn <ms> / --hold <ms>   the motion's timing, default the engine's
 *   --out <dir>      default ~/Desktop/bigbrain-logomark
 *   --name <base>    default bigbrain-<theme id>-<loop>[-lockup]
 *   --url <base>     the dev server, default http://localhost:5173
 */
const { spawnSync } = require("node:child_process");
const { mkdirSync, rmSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

if (flag("help") || flag("h")) {
  const src = require("node:fs").readFileSync(__filename, "utf8");
  process.stdout.write(src.slice(0, src.indexOf("*/")).replace(/^\/\*\*\n|^ \* ?/gm, "") + "\n");
  process.exit(0);
}

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright-core");

const want = opt("theme", "default");
const loop = opt("loop", "flip");
const size = Number(opt("size", "1024"));
const fps = Number(opt("fps", "60"));
const wordmark = flag("wordmark");
const out = opt("out", join(homedir(), "Desktop", "bigbrain-logomark"));
const url = opt("url", "http://localhost:5173");
const timing = ["turn", "hold"].filter((k) => opt(k)).map((k) => `&${k}=${opt(k)}`).join("");
const listThemes = (themes) => themes.map((t) => `  ${t.label.padEnd(24)} ${t.id}`).join("\n");

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "chrome" }).catch((e) => {
    throw new Error(`could not start Chrome (${e.message.split("\n")[0]}) — is it installed?`);
  });
  try {
    const page = await browser.newPage({ viewport: { width: Math.max(1600, size * 4), height: Math.max(900, size * 2) }, deviceScaleFactor: 1 });
    await page.route("**/api/**", (route) => route.abort());
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const stageUrl = `${url}/logomark.html?s=render&theme=${encodeURIComponent(want)}&loop=${loop}&size=${size}&wordmark=${wordmark ? 1 : 0}${timing}`;
    await page.goto(stageUrl).catch((e) => { throw new Error(`no dev server at ${url} (${e.message.split("\n")[0]}) — run \`bun run web:dev\` first, or pass --url`); });
    await page.waitForFunction(() => typeof window.__logomarkFrame === "function");
    const themes = await page.evaluate(() => window.__logomarkThemes);
    if (flag("list")) {
      process.stdout.write(`themes, as Settings › Theme names them, and by id:\n${listThemes(themes)}\n`);
      return;
    }
    const theme = await page.evaluate(() => window.__logomarkTheme);
    if (!theme) throw new Error(`"${want}" is not a theme. The themes:\n${listThemes(themes)}`);
    await page.evaluate(() => document.fonts.ready);
    const period = await page.evaluate(() => window.__logomarkPeriod);
    const seconds = Number(opt("seconds", String(period / 1000)));
    const frames = Math.round(seconds * fps);
    const name = opt("name", `bigbrain-${theme}-${loop}${wordmark ? "-lockup" : ""}`);
    const stage = await page.$(".render");
    // the theme's background, as the browser resolved it, for the opaque cut
    const bg = await page.evaluate(() => {
      const el = document.querySelector(".render");
      el.classList.add("opaque");
      const c = getComputedStyle(el).backgroundColor;
      el.classList.remove("opaque");
      return c;
    });
    const hex = "0x" + bg.match(/\d+/g).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");

    const framesDir = join(out, `${name}-frames`);
    rmSync(framesDir, { recursive: true, force: true });
    mkdirSync(framesDir, { recursive: true });
    const label = themes.find((t) => t.id === theme).label;
    process.stdout.write(`${frames} frames at ${fps} fps (${seconds.toFixed(2)} s, one pass = ${period} ms), theme ${label} (${theme}), loop ${loop}${wordmark ? ", lockup" : ""}\n`);
    for (let i = 0; i < frames; i++) {
      await page.evaluate((t) => window.__logomarkFrame(t), (i * 1000) / fps);
      await stage.screenshot({ path: join(framesDir, `${String(i).padStart(5, "0")}.png`), omitBackground: true });
      if (i % fps === 0) process.stdout.write(`  ${i}/${frames}\r`);
    }
    if (errors.length) throw new Error(`page errors:\n${errors.join("\n")}`);

    const input = ["-framerate", String(fps), "-i", join(framesDir, "%05d.png")];
    const even = "pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black@0";
    const run = (what, ffargs) => {
      const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...ffargs], { stdio: "inherit" });
      if (r.error) throw new Error(`ffmpeg is not on PATH (${r.error.message}) — \`brew install ffmpeg\``);
      if (r.status !== 0) throw new Error(`ffmpeg failed cutting the ${what}`);
    };
    const mov = join(out, `${name}.mov`), mp4 = join(out, `${name}.mp4`);
    run("mov", [...input, "-vf", even, "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", mov]);
    run("mp4", [...input, "-filter_complex", `[0:v]${even},split[a][b];[b]drawbox=c=${hex}:t=fill[bg];[bg][a]overlay=format=auto,format=yuv420p`, "-c:v", "libx264", "-crf", "16", "-r", String(fps), mp4]);
    process.stdout.write(`\n${mov}\n${mp4}\n${framesDir}/\n`);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message ?? e); process.exit(1); });
